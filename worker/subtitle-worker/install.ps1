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

# Supported interpreter window. The upper bound is not caution - it is a hard
# wheel gap. ffsubsync pulls webrtcvad-wheels and the NLLB path pulls
# tokenizers; neither publishes a cp314 wheel, so on Python 3.14 pip falls
# back to compiling from source and dies with "Microsoft Visual C++ 14.0 or
# greater is required". Raise MaxPython once those projects ship cp314.
$MinPython = [version]"3.10"
$MaxPython = [version]"3.14"   # exclusive

# Probing a native command's version is done with $ErrorActionPreference
# relaxed on purpose: PowerShell 5.1 turns a native process's stderr into
# ErrorRecords, and under "Stop" the first one is TERMINATING - the same trap
# documented at length in start.ps1. A Python that merely warns on startup
# would otherwise look like "not installed".
function Get-PythonVersion {
    param([string]$Exe)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $Exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $txt = ($out | Out-String).Trim()
        if ($txt -match '^\d+\.\d+$') { return [version]$txt }
    } catch { } finally { $ErrorActionPreference = $old }
    return $null
}

# Collect every interpreter on the box, not just whatever "python" resolves
# to: the py launcher knows about side-by-side installs, python.org's
# installer adds only the launcher when "Add python.exe to PATH" is left
# unchecked, and a PATH edit is invisible to an ALREADY-OPEN PowerShell.
$candidates = New-Object System.Collections.Generic.List[string]
$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        foreach ($line in (& $launcher.Source -0p 2>$null)) {
            # Parsed without a regex on purpose - the path is full of
            # backslashes and every escaping layer between here and the file
            # is one more chance to silently never match.
            $t = "$line".Trim()
            if ($t -like "*.exe") {
                $i = $t.IndexOf(":\")
                if ($i -gt 0) { $candidates.Add($t.Substring($i - 1)) }
            }
        }
    } catch { } finally { $ErrorActionPreference = $old }
}
foreach ($n in @("python", "py")) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { $candidates.Add($c.Source) }
}
foreach ($root in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python*", "C:\Python*")) {
    foreach ($p in (Get-ChildItem -Path $root -Filter "python.exe" -Recurse -Depth 1 -ErrorAction SilentlyContinue)) {
        $candidates.Add($p.FullName)
    }
}

# Highest version inside the window wins.
$pythonExe = $null
$pythonVer = $null
$rejected = @()
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    # WindowsApps entries are Microsoft Store redirector stubs, not interpreters.
    if ($candidate -like "*\WindowsApps\*") { continue }
    # Never seed a new venv from another venv's python - it may itself be a
    # stale build, and pyvenv.cfg chaining gets confusing fast.
    if (Test-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $candidate)) "pyvenv.cfg")) { continue }
    # [version], not [double]: as a double "3.9" -ge 3.10 is TRUE and a
    # too-old Python sailed through the check.
    $v = Get-PythonVersion $candidate
    if (-not $v) { continue }
    if ($v -lt $MinPython -or $v -ge $MaxPython) { $rejected += "$v at $candidate"; continue }
    if ((-not $pythonVer) -or ($v -gt $pythonVer)) { $pythonExe = $candidate; $pythonVer = $v }
}
if (-not $pythonExe) {
    $msg = "No supported Python found (need >= $MinPython and < $MaxPython; 3.13 is the newest that works)."
    if ($rejected) { $msg += " Found but unusable: " + ($rejected -join '; ') + "." }
    $msg += " Install 3.13 from https://www.python.org/downloads/release/python-31311/ (tick 'Add python.exe to PATH'), then open a NEW administrator PowerShell and re-run. It installs alongside an existing 3.14 - nothing is removed."
    Write-Error $msg
}
if ($rejected) { Write-Output "  (ignoring unsupported: $($rejected -join '; '))" }
Write-Output "  Python: OK ($pythonVer at $pythonExe)"

# ffmpeg is fetched as a static build into $InstallDir\bin rather than via a
# package manager. winget does not exist on Windows LTSC / IoT / Server
# images - they ship without the Store's App Installer - so "install winget
# first" was a dead end on exactly the always-on boxes this worker targets.
# A private copy also survives PATH changes and needs no shell restart.
$ffmpegDir = Join-Path $InstallDir "bin"
$ffmpegLocal = Join-Path $ffmpegDir "ffmpeg.exe"
if ((Test-Path $ffmpegLocal) -and (($env:Path -split ';') -notcontains $ffmpegDir)) {
    $env:Path = "$ffmpegDir;$env:Path"
}
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Output "  ffmpeg missing - downloading a static build (~160MB, one time)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ffZip = Join-Path $env:TEMP ("ffmpeg-{0}.zip" -f (Get-Random))
    $ffTmp = Join-Path $env:TEMP ("ffmpeg-x-{0}" -f (Get-Random))
    Invoke-WebRequest -UseBasicParsing -OutFile $ffZip `
        -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
    Expand-Archive -Path $ffZip -DestinationPath $ffTmp -Force
    New-Item -ItemType Directory -Force $ffmpegDir | Out-Null
    foreach ($tool in @("ffmpeg.exe", "ffprobe.exe")) {
        $src = Get-ChildItem $ffTmp -Recurse -Filter $tool | Select-Object -First 1
        if (-not $src) { Write-Error "ffmpeg archive did not contain $tool - aborting." }
        Copy-Item -Force $src.FullName (Join-Path $ffmpegDir $tool)
    }
    Remove-Item -Recurse -Force $ffTmp -ErrorAction SilentlyContinue
    Remove-Item -Force $ffZip -ErrorAction SilentlyContinue
    $env:Path = "$ffmpegDir;$env:Path"
    $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $ffmpeg) { Write-Error "ffmpeg still not runnable after download - aborting." }
}
# The scheduled task starts from a fresh environment, so a session-only PATH
# entry would not reach the worker. Persist our bin dir for it to inherit.
if (Test-Path $ffmpegLocal) {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if (($machinePath -split ';') -notcontains $ffmpegDir) {
        try {
            [Environment]::SetEnvironmentVariable("Path", "$machinePath;$ffmpegDir", "Machine")
            Write-Output "  Added $ffmpegDir to the machine PATH."
        } catch {
            # Not fatal: ffmpeg still sits beside the worker. Only worth a
            # warning on a box where policy locks the machine environment.
            Write-Output "  WARNING: could not persist $ffmpegDir to the machine PATH ($($_.Exception.Message))."
        }
    }
}
Write-Output "  ffmpeg: OK ($($ffmpeg.Source))"

$hasGpu = $false
try {
    & nvidia-smi | Out-Null
    if ($LASTEXITCODE -eq 0) { $hasGpu = $true }
} catch { }
if ($hasGpu) { Write-Output "  NVIDIA GPU: found (transcription: large-v3, CUDA)" }
else { Write-Output "  NVIDIA GPU: NOT found (CPU worker: sync + small-model transcription)" }

Write-Output "== Setting up $InstallDir =="
New-Item -ItemType Directory -Force $InstallDir | Out-Null
$venvDir = Join-Path $InstallDir "venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
# A venv built by an out-of-window interpreter is rebuilt, never reused: an
# earlier run on an unsupported Python otherwise leaves behind a venv that can
# never install the dependencies, and the "already exists" shortcut below
# would silently keep it forever.
if (Test-Path $venvPython) {
    $venvVer = Get-PythonVersion $venvPython
    if ((-not $venvVer) -or ($venvVer -lt $MinPython) -or ($venvVer -ge $MaxPython)) {
        Write-Output "  Existing venv is Python $venvVer (unsupported) - rebuilding on $pythonVer."
        Remove-Item -Recurse -Force $venvDir
    }
}
if (-not (Test-Path $venvPython)) {
    & $pythonExe -m venv $venvDir
    if (-not (Test-Path $venvPython)) { Write-Error "Failed to create the virtualenv at $venvDir." }
}
& $venvPython -m pip install --upgrade pip --quiet
Write-Output "== Installing packages (first run downloads a lot, be patient) =="
# ffsubsync pinned - see install.sh for why (the worker relies on specific
# --skip-sync-on-low-quality behavior an unpinned reinstall could silently change).
& $venvPython -m pip install --quiet fastapi uvicorn "ffsubsync==0.5.0" faster-whisper
# Aborting here matters: without this check a failed pip run fell through to
# the model download and the enrollment banner, so the installer reported
# success and printed an API key for a worker that could never start.
if ($LASTEXITCODE -ne 0) { Write-Error "pip failed to install the core worker packages - aborting (see the pip error above)." }
if ($hasGpu) {
    & $venvPython -m pip install --quiet nvidia-cublas-cu12 nvidia-cudnn-cu12
    if ($LASTEXITCODE -ne 0) { Write-Error "pip failed to install the CUDA runtime packages - aborting." }
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
    # Point the worker at the model explicitly. It now also defaults to a
    # "nllb-ct2" folder beside itself, which covers this install layout, but
    # writing it makes a relocated INSTALL_DIR work too - and makes the
    # setting visible in the env file rather than implicit.
    if (Test-Path $nllbDir) {
        Add-Content -Encoding utf8 $envFile "SUBWORKER_NLLB_DIR=$nllbDir"
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
