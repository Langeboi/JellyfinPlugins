# Subtitle-worker self-update (Windows) - mirrors the Linux timer: fetch the
# latest worker from main, verify it compiles, skip if the worker is busy,
# swap the file and bounce the process (start.ps1's loop relaunches it).
$ErrorActionPreference = "Stop"
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RawBase = "https://raw.githubusercontent.com/Langeboi/JellyfinPlugins/main/worker/subtitle-worker"
$python = Join-Path $InstallDir "venv\Scripts\python.exe"
$workerFile = Join-Path $InstallDir "subtitle_worker.py"

# Respect the same opt-out as Linux.
$envFile = Join-Path $InstallDir "env"
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern "^SUBWORKER_AUTOUPDATE=0" -Quiet)) {
    Write-Output "auto-update disabled (SUBWORKER_AUTOUPDATE=0)"
    exit 0
}

# Don't update mid-job: ask the local worker if it's busy.
$port = "8099"
$key = ""
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match "^SUBWORKER_PORT=(.+)$") { $port = $Matches[1].Trim() }
        if ($line -match "^SUBWORKER_API_KEY=(.+)$") { $key = $Matches[1].Trim() }
    }
}
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers @{ "X-Api-Key" = $key } -TimeoutSec 10
    if (($status.active -gt 0) -or ($status.queue_depth -gt 0)) {
        Write-Output "worker busy (active=$($status.active) queue=$($status.queue_depth)), deferring update"
        exit 0
    }
} catch {
    Write-Output "worker not reachable - updating anyway (it may be mid-restart)"
}

$tmp = Join-Path $env:TEMP ("subtitle_worker_new_{0}.py" -f (Get-Random))
Invoke-WebRequest -Uri "$RawBase/subtitle_worker.py" -OutFile $tmp -UseBasicParsing

& $python -m py_compile $tmp
if ($LASTEXITCODE -ne 0) {
    Write-Output "downloaded worker does not compile - keeping current version"
    Remove-Item -Force $tmp
    exit 1
}

$currentVersion = (Select-String -Path $workerFile -Pattern 'WORKER_VERSION = "(.+)"').Matches[0].Groups[1].Value
$newVersion = (Select-String -Path $tmp -Pattern 'WORKER_VERSION = "(.+)"').Matches[0].Groups[1].Value
if ($currentVersion -eq $newVersion) {
    Write-Output "already on $currentVersion"
    Remove-Item -Force $tmp
    exit 0
}

Copy-Item -Force $tmp $workerFile
Remove-Item -Force $tmp

# Also refresh the wrapper scripts themselves (best effort - a failure here
# never blocks the worker update).
foreach ($script in @("start.ps1", "update.ps1")) {
    try {
        $stmp = Join-Path $env:TEMP ("sg_{0}_{1}" -f (Get-Random), $script)
        Invoke-WebRequest -Uri "$RawBase/$script" -OutFile $stmp -UseBasicParsing
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($stmp, [ref]$null, [ref]$parseErrors)
        if ($parseErrors.Count -eq 0) { Copy-Item -Force $stmp (Join-Path $InstallDir $script) }
        Remove-Item -Force $stmp -ErrorAction SilentlyContinue
    } catch { }
}

# Bounce the worker process; start.ps1's loop relaunches it on the new file.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like "*subtitle_worker.py*" }
foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false } catch { }
}
Write-Output "updated $currentVersion -> $newVersion and restarted the worker"
