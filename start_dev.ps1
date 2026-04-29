# =====================================================================
# LEGO CAD Simulation - Full Stack Orchestrator
# =====================================================================

$ErrorActionPreference = "Stop"

# =====================================================================
# Idempotency Guard Helpers 
# =====================================================================
function Clear-Port {
    param (
        [Parameter(Mandatory=$true)]
        [int]$Port
    )
    
    Write-Host "[DEBUG] Clear-Port() invoked. Target Port: $Port" -ForegroundColor DarkGray
    
    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $connections) {
        Write-Host "[DEBUG] Target Port $Port is currently free. No zombie processes detected." -ForegroundColor DarkGray
        return
    }

    $pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    Write-Host "[DEBUG] Active connections detected on Port $Port. Owning PIDs: $($pids -join ', ')" -ForegroundColor DarkGray

    foreach ($pidToKill in $pids) {
        if ($pidToKill -eq 0 -or $pidToKill -eq 4) {
            Write-Host "[DEBUG] Skipping system idle/system process (PID: $pidToKill)." -ForegroundColor DarkGray
            continue
        }

        $process = Get-Process -Id $pidToKill -ErrorAction SilentlyContinue
        if ($process) {
            Write-Host "  -> [INFO] Reclaiming port $Port from zombie process '$($process.ProcessName)' (PID: $pidToKill)..." -ForegroundColor Yellow
            try {
                Stop-Process -Id $pidToKill -Force -ErrorAction Stop
                Write-Host "[DEBUG] Successfully dispatched SIGKILL to PID $pidToKill." -ForegroundColor DarkGray
            } catch {
                Write-Host "  -> [ERROR] Failed to forcefully reap PID $($pidToKill): $($_.Exception.Message)" -ForegroundColor Red
            }
        } else {
            Write-Host "[DEBUG] PID $pidToKill no longer exists in process table." -ForegroundColor DarkGray
        }
    }
    
    Write-Host "[DEBUG] Awaiting OS TCP socket flush for Port $Port..." -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 500
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  LEGO CAD Simulator - Dev Environment Boot" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 工作树可见性：脚本以 cwd 为基准，不绑定脚本所在目录。
# 这样允许在 git worktree / 任意子检出复用同一脚本：cwd 指哪儿就启哪儿。
$workTreeRoot = (Get-Location).Path
$branchName = $null
try {
    $branchName = (git -C $workTreeRoot rev-parse --abbrev-ref HEAD 2>$null)
    if ($branchName) { $branchName = $branchName.Trim() }
} catch {
    # 不是 git 仓库就跳过，不影响脚本主流程
}
Write-Host ("  Working tree : {0}" -f $workTreeRoot) -ForegroundColor Cyan
if ($branchName) {
    Write-Host ("  Git branch   : {0}" -f $branchName) -ForegroundColor Cyan
}

# 计算主仓根：worktree 共享主仓的 .git/，git rev-parse --git-common-dir 始终指向主仓的 .git
# 路径，其父目录即主仓根。在主仓 checkout 中，common-dir == git-dir，主仓根就是 cwd 自身。
$mainRepoRoot = $workTreeRoot
try {
    $commonDir = (git -C $workTreeRoot rev-parse --path-format=absolute --git-common-dir 2>$null)
    if ($commonDir) {
        $commonDir = $commonDir.Trim()
        $candidate = (Split-Path -Parent $commonDir)
        if ($candidate -and (Test-Path $candidate)) {
            $mainRepoRoot = (Resolve-Path $candidate).Path
        }
    }
} catch {
    # not git or git not on PATH —保持默认（cwd），不影响主仓 checkout 场景
}

# 当 cwd 不是主仓自身（即位于 git worktree）时，把后端的资产根显式指向主仓的 data/ 与 ldraw_lib/，
# 否则后端会按 backend/__file__ 解析到 worktree 自己空的 data/，导致 /ldraw_meshes/*.glb 全部 404。
$isWorktree = ($mainRepoRoot -ne $workTreeRoot)
if ($isWorktree) {
    $env:MESH_CACHE_ROOT  = Join-Path $mainRepoRoot "data\custom_assets"
    $env:LDRAW_PARTS_ROOT = Join-Path $mainRepoRoot "ldraw_lib"
    Write-Host ("  Main repo    : {0}  [WORKTREE — pointing assets here]" -f $mainRepoRoot) -ForegroundColor Yellow
    Write-Host ("    MESH_CACHE_ROOT  = {0}" -f $env:MESH_CACHE_ROOT)  -ForegroundColor DarkGray
    Write-Host ("    LDRAW_PARTS_ROOT = {0}" -f $env:LDRAW_PARTS_ROOT) -ForegroundColor DarkGray
}
Write-Host ""

Write-Host "`n[1/5] Starting Meilisearch Docker container..." -ForegroundColor Yellow
# 固定 docker-compose 项目名，避免不同 worktree（cwd basename 不同）各自尝试新建
# 同名 container 而冲突。容器名 lego_meilisearch 在 yml 中已固定，所有 checkout 共享同一实例。
docker-compose -p lego_cad_sim up -d meilisearch
if ($LASTEXITCODE -ne 0) {
    Write-Error "Fatal: docker-compose failed. Is Docker Desktop running?"
    exit 1
}

Write-Host "`n[2/5] Waiting for Meilisearch 7700 health check..." -ForegroundColor Yellow
$retryCount = 0
$meiliReady = $false

while ($retryCount -lt 30) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:7700/health" -Method Get -ErrorAction Stop
        if ($response.status -eq 'available') {
            $meiliReady = $true
            break
        }
    } catch {
        # Ignore and retry
    }
    Start-Sleep -Seconds 1
    $retryCount++
    Write-Host "." -NoNewline -ForegroundColor Gray
}
Write-Host "" # Newline

if (-not $meiliReady) {
    Write-Error "Fatal: Meilisearch failed health check after 30 seconds. Boot sequence aborted."
    exit 1
}
Write-Host "  -> Meilisearch (127.0.0.1:7700) is HEALTHY [GREEN]" -ForegroundColor Green

Write-Host "`n[3/5] Syncing LDraw configurations to inverted index..." -ForegroundColor Yellow
try {
    python backend/sync_meili.py
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fatal: Data sync script exited with non-zero status."
        exit 1
    }
} catch {
    Write-Error "Fatal: Failed to execute python backend/sync_meili.py"
    exit 1
}
Write-Host "  -> Data sync sequence completed." -ForegroundColor Green

Write-Host "`n[4/5] Idempotency Guard: Pre-flight sniffing for ports 8000 + Vite range 5173-5180..." -ForegroundColor Yellow
# 后端只在 8000 监听
Clear-Port -Port 8000
# Vite 在 5173 占用时会自动回退到 5174/5175...，必须把整段回退区都清掉，
# 否则在多个 checkout 之间切换时会留下僵尸 Vite 实例继续吃端口。
foreach ($vitePort in 5173..5180) {
    Clear-Port -Port $vitePort
}

Write-Host "`n[5/5] Spawning separated terminal instances for Backend and UI..." -ForegroundColor Yellow

Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Backend Engine 8000] && echo [INFO] Booting FastAPI Core... && python -m backend.server`""
Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Frontend Viewport 5173] && echo [INFO] Booting React UI... && cd frontend && npm run dev`""

Write-Host "=============================================" -ForegroundColor Green
Write-Host "  All microservice nodes successfully bootstrapped! " -ForegroundColor Green
Write-Host "  -> API Gateway running in background (Port 8000)" -ForegroundColor Green
Write-Host "  -> Vite UI Engine running in background (Port 5173)" -ForegroundColor Green
Write-Host "  Please access http://localhost:5173 in browser." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
