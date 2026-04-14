# =====================================================================
# LEGO CAD Simulation - Full Stack Orchestrator
# =====================================================================

$ErrorActionPreference = "Stop"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  LEGO CAD Simulator - Dev Environment Boot" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

Write-Host "`n[1/4] Starting Meilisearch Docker container..." -ForegroundColor Yellow
docker-compose up -d meilisearch
if ($LASTEXITCODE -ne 0) {
    Write-Error "Fatal: docker-compose failed. Is Docker Desktop running?"
    exit 1
}

Write-Host "`n[2/4] Waiting for Meilisearch 7700 health check..." -ForegroundColor Yellow
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

Write-Host "`n[3/4] Syncing LDraw configurations to inverted index..." -ForegroundColor Yellow
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

Write-Host "`n[4/4] Spawning separated terminal instances for Backend and UI..." -ForegroundColor Yellow

Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Backend Engine 8000] && echo [INFO] Booting FastAPI Core... && python -m backend.server`""
Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title [Frontend Viewport 5173] && echo [INFO] Booting React UI... && cd frontend && npm run dev`""

Write-Host "=============================================" -ForegroundColor Green
Write-Host "  All microservice nodes successfully bootstrapped! " -ForegroundColor Green
Write-Host "  -> API Gateway running in background (Port 8000)" -ForegroundColor Green
Write-Host "  -> Vite UI Engine running in background (Port 5173)" -ForegroundColor Green
Write-Host "  Please access http://localhost:5173 in browser." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
