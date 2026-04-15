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

Write-Host "`n[1/5] Starting Meilisearch Docker container..." -ForegroundColor Yellow
docker-compose up -d meilisearch
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

Write-Host "`n[4/5] Idempotency Guard: Pre-flight sniffing for ports 8000 & 5173..." -ForegroundColor Yellow
Clear-Port -Port 8000
Clear-Port -Port 5173

Write-Host "`n[5/5] Spawning separated terminal instances for Backend and UI..." -ForegroundColor Yellow

Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Backend Engine 8000] && echo [INFO] Booting FastAPI Core... && python -m backend.server`""
Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Frontend Viewport 5173] && echo [INFO] Booting React UI... && cd frontend && npm run dev`""

Write-Host "=============================================" -ForegroundColor Green
Write-Host "  All microservice nodes successfully bootstrapped! " -ForegroundColor Green
Write-Host "  -> API Gateway running in background (Port 8000)" -ForegroundColor Green
Write-Host "  -> Vite UI Engine running in background (Port 5173)" -ForegroundColor Green
Write-Host "  Please access http://localhost:5173 in browser." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
