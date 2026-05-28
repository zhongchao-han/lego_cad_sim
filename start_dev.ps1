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
# 同理，云端备份的 SQLite 库（data/builds.db）也必须指回主仓，否则每个 worktree 各用各的空库，
# 跨 worktree 起服务会看不到彼此搭的云端备份（build_store.py 默认按 backend/__file__ 解析到本 worktree）。
$isWorktree = ($mainRepoRoot -ne $workTreeRoot)
if ($isWorktree) {
    $env:MESH_CACHE_ROOT  = Join-Path $mainRepoRoot "data\custom_assets"
    $env:LDRAW_PARTS_ROOT = Join-Path $mainRepoRoot "ldraw_lib"
    $env:BUILDS_DB_PATH   = Join-Path $mainRepoRoot "data\builds.db"
    Write-Host ("  Main repo    : {0}  [WORKTREE — pointing assets here]" -f $mainRepoRoot) -ForegroundColor Yellow
    Write-Host ("    MESH_CACHE_ROOT  = {0}" -f $env:MESH_CACHE_ROOT)  -ForegroundColor DarkGray
    Write-Host ("    LDRAW_PARTS_ROOT = {0}" -f $env:LDRAW_PARTS_ROOT) -ForegroundColor DarkGray
    Write-Host ("    BUILDS_DB_PATH   = {0}" -f $env:BUILDS_DB_PATH)   -ForegroundColor DarkGray

    # Worktree 的 frontend/ 默认没有 node_modules（每个 worktree 各自 npm install 既慢又
    # 容易和主仓版本 drift）。若缺失，则用 NTFS Junction 链接到主仓的 node_modules：
    # Junction 不需要管理员权限，对 vite/npm 完全透明，与真实目录无差异。
    $worktreeNodeModules = Join-Path $workTreeRoot "frontend\node_modules"
    $mainNodeModules     = Join-Path $mainRepoRoot "frontend\node_modules"
    if (-not (Test-Path $worktreeNodeModules)) {
        if (Test-Path $mainNodeModules) {
            Write-Host ("    Linking frontend\node_modules -> main repo (junction)") -ForegroundColor DarkGray
            New-Item -ItemType Junction -Path $worktreeNodeModules -Target $mainNodeModules | Out-Null
        } else {
            Write-Host "    [WARN] Main repo 也没有 frontend\node_modules，请先在主仓 frontend 下执行 'npm install'。" -ForegroundColor Yellow
        }
    }
}
Write-Host ""

Write-Host "`n[1/3] Ensuring local vector search index exists..." -ForegroundColor Yellow
# 本地向量语义搜索取代了 Meilisearch 服务：索引就是 data/part_vectors.npy（已入库）。
# 仅当向量文件缺失（如全新 checkout）时才离线重建——重建需加载 e5 模型、耗时约 1-2 分钟。
$vectorsFile = Join-Path $workTreeRoot "data\part_vectors.npy"
if (-not (Test-Path $vectorsFile)) {
    Write-Host "  -> part_vectors.npy 缺失，开始离线构建（首次会下载 e5 模型）..." -ForegroundColor Gray
    try {
        # 用 module 形式 (-m)，否则 backend.category 之类的相对导入会 ModuleNotFoundError。
        python -m backend.build_search_index
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Fatal: 向量索引构建脚本退出码非 0。"
            exit 1
        }
    } catch {
        Write-Error "Fatal: 执行 python -m backend.build_search_index 失败"
        exit 1
    }
    Write-Host "  -> 向量索引构建完成。" -ForegroundColor Green
} else {
    Write-Host "  -> 已存在向量索引，跳过构建。" -ForegroundColor Green
}

Write-Host "`n[2/3] Idempotency Guard: Pre-flight sniffing for ports 8000 + Vite range 5173-5180..." -ForegroundColor Yellow
# 后端只在 8000 监听
Clear-Port -Port 8000
# Vite 在 5173 占用时会自动回退到 5174/5175...，必须把整段回退区都清掉，
# 否则在多个 checkout 之间切换时会留下僵尸 Vite 实例继续吃端口。
foreach ($vitePort in 5173..5180) {
    Clear-Port -Port $vitePort
}

Write-Host "`n[3/3] Spawning separated terminal instances for Backend and UI..." -ForegroundColor Yellow

# 显式把工作目录钉在 $workTreeRoot：在 worktree 中启动时确保子进程不会因为 PowerShell
# 默认继承策略变化而跑到主仓目录，导致 backend 模块解析错位 / vite 服务到主仓的旧代码。
Start-Process -FilePath "cmd.exe" -WorkingDirectory $workTreeRoot -ArgumentList "/k `"title [Backend Engine 8000] && echo [INFO] Booting FastAPI Core... && python -m backend.server`""
Start-Process -FilePath "cmd.exe" -WorkingDirectory $workTreeRoot -ArgumentList "/k `"title [Frontend Viewport 5173] && echo [INFO] Booting React UI... && cd frontend && npm run dev`""

Write-Host "=============================================" -ForegroundColor Green
Write-Host "  All microservice nodes successfully bootstrapped! " -ForegroundColor Green
Write-Host "  -> API Gateway running in background (Port 8000)" -ForegroundColor Green
Write-Host "  -> Vite UI Engine running in background (Port 5173)" -ForegroundColor Green
Write-Host "  Please access http://localhost:5173 in browser." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
