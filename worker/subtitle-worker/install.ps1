# Subtitle-worker installer for WINDOWS GPU machines (Subtitle Guard).
#
# Run in an ADMINISTRATOR PowerShell:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   irm https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker/install.ps1 -OutFile install.ps1
#   .\install.ps1
#
# Optional configuration via environment variables before running:
#   $env:INSTALL_DIR    = "C:\subtitle-worker"   (default)
#   $env:WORKER_PORT    = "8099"                 (default)
#   $env:SERVICE_NAME   = "subtitle-worker"      (default; task names)
#   $env:WITH_TRANSLATE = "0"                    (skip NLLB translation)
#
# What you get: a worker identical to the Linux one, started hidden at logon
# with restart-always semantics (required by the worker's idle-restart, which
# exits to free VRAM when a batch is done), a firewall rule, and a daily
# self-update task. Media access: the plugin sends Linux-style paths - set
# SUBWORKER_PATH_FROM / SUBWORKER_PATH_TO in the env file afterwards, e.g.
#   SUBWORKER_PATH_FROM=/Media
#   SUBWORKER_PATH_TO=\\10.10.100.3\Media
# Use UNC paths, not mapped drive letters - drive mappings don't exist in
# the scheduled task's session.

$ErrorActionPreference = "Stop"

$InstallDir = $env:INSTALL_DIR
if (-not $InstallDir) { $InstallDir = "C:\subtitle-worker" }
$WorkerPort = $env:WORKER_PORT
if (-not $WorkerPort) { $WorkerPort = "8099" }
$ServiceName = $env:SERVICE_NAME
if (-not $ServiceName) { $ServiceName = "subtitle-worker" }
$RawBase = "https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Run this in an ADMINISTRATOR PowerShell (firewall rule + scheduled tasks need it)."
}

Write-Output "== Checking prerequisites =="
$pythonExe = $null
foreach ($candidate in @("python", "py")) {
    try {
        $ver = & $candidate -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and [double]$ver -ge 3.10) { $pythonExe = $candidate; break }
    } catch { }
}
if (-not $pythonExe) {
    Write-Error "Python 3.10+ not found. Install from https://www.python.org/downloads/ (check 'Add to PATH') and re-run."
}
Write-Output "  Python: OK ($pythonExe)"

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Output "  ffmpeg missing - installing via winget..."
        winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
        Write-Output "  NOTE: re-open PowerShell if ffmpeg is not found on PATH after this."
    } else {
        Write-Error "ffmpeg not found and winget unavailable. Install ffmpeg (https://www.gyan.dev/ffmpeg/builds/) and add it to PATH."
    }
}
Write-Output "  ffmpeg: OK"

$hasGpu = $false
try {
    & nvidia-smi | Out-Null
    if ($LASTEXITCODE -eq 0) { $hasGpu = $true }
} catch { }
if ($hasGpu) { Write-Output "  NVIDIA GPU: found (transcription: large-v3, CUDA)" }
else { Write-Output "  NVIDIA GPU: NOT found (CPU worker: sync + small-model transcription)" }

Write-Output "== Setting up $InstallDir =="
New-Item -ItemType Directory -Force $InstallDir | Out-Null
$venvPython = Join-Path $InstallDir "venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    & $pythonExe -m venv (Join-Path $InstallDir "venv")
}
& $venvPython -m pip install --upgrade pip --quiet
Write-Output "== Installing packages (first run downloads a lot, be patient) =="
& $venvPython -m pip install --quiet fastapi uvicorn ffsubsync faster-whisper
if ($hasGpu) {
    & $venvPython -m pip install --quiet nvidia-cublas-cu12 nvidia-cudnn-cu12
}

Write-Output "== Fetching worker + wrapper scripts =="
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($f in @("subtitle_worker.py", "start.ps1", "update.ps1")) {
    $local = Join-Path $scriptDir $f
    $dest = Join-Path $InstallDir $f
    if ((Test-Path $local) -and ($scriptDir -ne $InstallDir)) { Copy-Item -Force $local $dest }
    elseif (-not (Test-Path $local)) { Invoke-WebRequest -Uri "$RawBase/$f" -OutFile $dest -UseBasicParsing }
}
& $venvPython -m py_compile (Join-Path $InstallDir "subtitle_worker.py")
if ($LASTEXITCODE -ne 0) { Write-Error "Downloaded worker does not compile - aborting." }

# Re-running the installer must NOT rotate the API key (would silently break
# the enrollment in the plugin) - same rule as the Linux installer.
$envFile = Join-Path $InstallDir "env"
$apiKey = $null
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match "^SUBWORKER_API_KEY=(.+)$") { $apiKey = $Matches[1].Trim() }
    }
}
if ($apiKey) { Write-Output "== Keeping existing API key ==" }
else {
    Write-Output "== Generating API key =="
    $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    $apiKey = -join (1..32 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}

$hfCache = Join-Path $InstallDir "hf-cache"
New-Item -ItemType Directory -Force $hfCache | Out-Null
$whisperModel = "small"
if ($hasGpu) {
    $whisperModel = "large-v3"
} else {
    # Same speed-aware auto-pick as the Linux installer: capable CPU boxes
    # (>=4 cores AND >=6GB RAM) get 'medium', weak ones 'small'. Never
    # auto-select large-v3 on CPU.
    $cs = Get-CimInstance Win32_ComputerSystem
    $cores = [int]$cs.NumberOfLogicalProcessors
    $ramGb = [math]::Floor($cs.TotalPhysicalMemory / 1GB)
    if ($cores -ge 4 -and $ramGb -ge 6) { $whisperModel = "medium" }
    Write-Output "  CPU auto-pick: $cores cores, ${ramGb}GB RAM -> Whisper '$whisperModel'"
}

@"
SUBWORKER_API_KEY=$apiKey
SUBWORKER_PORT=$WorkerPort
SUBWORKER_MIN_OFFSET=0.4
SUBWORKER_DB=$InstallDir\processed.db
HF_HOME=$hfCache
# The plugin sends Linux-style paths - map them to where THIS box sees the
# media. Use UNC, not mapped drive letters (mappings don't exist in the
# scheduled task's session). Example:
# SUBWORKER_PATH_FROM=/Media
# SUBWORKER_PATH_TO=\\10.10.100.3\Media
# Restart the worker after a batch is done to free VRAM (default on):
# SUBWORKER_IDLE_RESTART=0
# Pin to sync-only:
# SUBWORKER_TRANSCRIBE=0
# Run NLLB translation on CPU instead of sharing the GPU with Whisper:
# SUBWORKER_NLLB_DEVICE=cpu
# Disable the daily self-update:
# SUBWORKER_AUTOUPDATE=0
"@ | Out-File -Encoding utf8 $envFile

if (-not $hasGpu -and $whisperModel -ne "small") {
    # Pin the auto-picked CPU model - the runtime otherwise defaults to
    # 'small' on CPU and the pre-downloaded model would sit unused.
    Add-Content -Encoding utf8 $envFile "SUBWORKER_WHISPER_MODEL=$whisperModel"
}

Write-Output "== Pre-downloading Whisper model ($whisperModel) =="
$env:HF_HOME = $hfCache
& $venvPython -c "from faster_whisper import download_model; download_model('$whisperModel')"

$withTranslate = $env:WITH_TRANSLATE
if (-not $withTranslate) { $withTranslate = "1" }
if ($hasGpu -and $withTranslate -eq "1") {
    $nllbDir = Join-Path $InstallDir "nllb-ct2"
    & $venvPython -m pip install --quiet transformers sentencepiece
    & $venvPython -m pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu
    if (Test-Path $nllbDir) {
        Write-Output "== NLLB translation model already present, keeping it =="
    } else {
        Write-Output "== Converting NLLB translation model (~6GB download, be patient) =="
        $converter = Join-Path $InstallDir "venv\Scripts\ct2-transformers-converter.exe"
        & $converter --model facebook/nllb-200-distilled-1.3B --output_dir $nllbDir --quantization float16 --force
        if ($LASTEXITCODE -ne 0) {
            Write-Output "WARNING: NLLB conversion failed - translation disabled on this worker."
            if (Test-Path $nllbDir) { Remove-Item -Recurse -Force $nllbDir }
        }
    }
    # Tokenizer ensured on EVERY run - the hard-earned lesson from Linux: a
    # single silently-failed pre-cache left translation broken for months.
    if (Test-Path $nllbDir) {
        $env:HF_HUB_OFFLINE = "0"; $env:TRANSFORMERS_OFFLINE = "0"
        & $venvPython -c "from transformers import AutoTokenizer; AutoTokenizer.from_pretrained('facebook/nllb-200-distilled-1.3B', src_lang='eng_Latn'); print('nllb tokenizer cached OK')"
        if ($LASTEXITCODE -ne 0) {
            Write-Output "WARNING: NLLB tokenizer could not be cached - translation WILL FAIL until it is. Re-run this installer with internet access."
        }
    }
}

Write-Output "== Firewall rule =="
Remove-NetFirewallRule -DisplayName $ServiceName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ServiceName -Direction Inbound -Protocol TCP -LocalPort $WorkerPort -Action Allow | Out-Null

Write-Output "== Scheduled tasks =="
$psExe = "powershell.exe"
$startArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'start.ps1')`""
$updateArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'update.ps1')`""
$user = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$workerAction = New-ScheduledTaskAction -Execute $psExe -Argument $startArgs
$workerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
Register-ScheduledTask -TaskName $ServiceName -Action $workerAction -Trigger $workerTrigger -Settings $settings -Force | Out-Null
$updateAction = New-ScheduledTaskAction -Execute $psExe -Argument $updateArgs
$updateTrigger = New-ScheduledTaskTrigger -Daily -At 05:00
Register-ScheduledTask -TaskName "$ServiceName-update" -Action $updateAction -Trigger $updateTrigger -Settings $settings -Force | Out-Null

# Start it now (idempotent: kill a previous instance first, the task rewraps).
$procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like "*subtitle_worker.py*" }
foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false } catch { } }
Start-ScheduledTask -TaskName $ServiceName

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1).IPAddress
Write-Output ""
Write-Output "======================================================="
Write-Output " Worker installed. Enroll it in the Subtitle Guard plugin:"
Write-Output ""
Write-Output "   Worker URL:      http://${ip}:$WorkerPort"
Write-Output "   Enrollment-kode: $apiKey"
Write-Output ""
Write-Output " IMPORTANT before it can do real work:"
Write-Output "   1) Edit $envFile and set SUBWORKER_PATH_FROM / SUBWORKER_PATH_TO"
Write-Output "      (UNC path to the media share as THIS machine sees it)."
Write-Output "   2) The task runs as $user at logon - the machine must be"
Write-Output "      logged in, and that account must have access to the share."
Write-Output "   3) Then: Stop-ScheduledTask -TaskName $ServiceName; Start-ScheduledTask -TaskName $ServiceName"
Write-Output "======================================================="
