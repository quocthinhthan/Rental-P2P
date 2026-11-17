# =========================
# P2P Rental - Start All Services
# =========================

Write-Host "===================================" -ForegroundColor Cyan
Write-Host " Starting Full Stack Application "
Write-Host "===================================" -ForegroundColor Cyan

# Read the same MongoDB configuration as the backend without printing the URI.
$ROOT = $PSScriptRoot
$readMongoTarget = @'
const path = require('node:path');
const root = process.argv[2];
const dotenv = require(path.join(root, 'backend', 'node_modules', 'dotenv'));
dotenv.config({ path: path.join(root, '.env'), quiet: true });
dotenv.config({ path: path.join(root, 'backend', '.env'), quiet: true });

const uri = process.env.MONGO_URI;
const local = /^mongodb:\/\/(?:[^/]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/,?]|$)/i;
console.log(!uri ? 'missing' : local.test(uri) ? 'local' : 'remote');
'@

$mongoTarget = $readMongoTarget | & node - $ROOT
if ($LASTEXITCODE -ne 0) {
    throw 'Could not read MongoDB configuration. Check Node.js and run npm install in backend if needed.'
}

function Start-LocalService {
    param([string]$Name)

    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service) {
        Write-Warning "$Name Windows service is unavailable."
    } elseif ($service.Status -eq 'Running') {
        Write-Host "$Name already running." -ForegroundColor Green
    } else {
        try {
            Start-Service -Name $Name -ErrorAction Stop
            Write-Host "$Name started." -ForegroundColor Green
        } catch {
            Write-Warning "Could not start ${Name}: $($_.Exception.Message)"
        }
    }
}

# =========================
# Check MongoDB
# =========================
Write-Host "`n[1/5] Checking MongoDB..." -ForegroundColor Yellow

switch ($mongoTarget) {
    'local'   { Start-LocalService -Name MongoDB }
    'remote'  { Write-Host 'Using remote MongoDB; no local service needed.' -ForegroundColor Green }
    'missing' { Write-Warning 'MONGO_URI is missing. Set it in .env before starting the backend.' }
}

# =========================
# Check RabbitMQ
# =========================
Write-Host "`n[2/5] Checking RabbitMQ..." -ForegroundColor Yellow

Start-LocalService -Name RabbitMQ

# =========================
# Start Backend
# =========================
Write-Host "`n[3/5] Starting Backend..." -ForegroundColor Yellow

Start-Process powershell `
    -ArgumentList "-NoExit", "-Command", "cd '$ROOT\backend'; npm start"

# =========================
# Start Frontend
# =========================
Write-Host "`n[4/5] Starting Frontend..." -ForegroundColor Yellow

Start-Process powershell `
    -ArgumentList "-NoExit", "-Command", "cd '$ROOT\frontend'; npm start"

# =========================
# Start Notification Worker
# =========================
Write-Host "`n[5/5] Starting Notification Worker..." -ForegroundColor Yellow

Start-Process powershell `
    -ArgumentList "-NoExit", "-Command", "cd '$ROOT\notification-worker'; npm start"

# =========================
# Wait & Open Browser
# =========================
Write-Host "`nWaiting for services to boot..." -ForegroundColor Cyan

Start-Sleep -Seconds 8

Start-Process "http://localhost:3000"

Write-Host "`n===================================" -ForegroundColor Cyan
Write-Host " Launch complete. Check the service windows for startup status. "
Write-Host "===================================" -ForegroundColor Cyan
