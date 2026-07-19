# Subtitle-worker start wrapper (Windows).
# Loads the env file, exposes the CUDA DLLs pip installed into the venv, and
# runs the worker in a restart-always loop: exit code 0 is the worker's own
# idle-restart (models released - relaunch immediately), anything else is a
# crash (relaunch after a short backoff). Runs hidden via the scheduled task
# install.ps1 registers.
$ErrorActionPreference = "Stop"
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# KEY=VALUE lines; '#' starts a comment. Same format as the Linux env file.
function Load-EnvFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
        $idx = $trimmed.IndexOf("=")
        if ($idx -lt 1) { continue }
        $name = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

Load-EnvFile (Join-Path $InstallDir "env")

# ctranslate2/faster-whisper find cuBLAS/cuDNN via PATH on Windows; the pip
# wheels put the DLLs under site-packages\nvidia\*\bin.
$sitePackages = Join-Path $InstallDir "venv\Lib\site-packages"
foreach ($sub in @("nvidia\cublas\bin", "nvidia\cudnn\bin")) {
    $dllDir = Join-Path $sitePackages $sub
    if (Test-Path $dllDir) { $env:Path = "$dllDir;$env:Path" }
}

$python = Join-Path $InstallDir "venv\Scripts\python.exe"
$worker = Join-Path $InstallDir "subtitle_worker.py"
$log = Join-Path $InstallDir "worker.log"

while ($true) {
    # Append-with-cap so the log can't grow unbounded on an always-on box.
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 10MB)) {
        $rotated = Join-Path $InstallDir "worker.log.1"
        Move-Item -Force $log $rotated
    }
    "[start.ps1] $(Get-Date -Format s) launching worker" | Out-File -Append -Encoding utf8 $log
    & $python $worker >> $log 2>&1
    $code = $LASTEXITCODE
    "[start.ps1] $(Get-Date -Format s) worker exited with code $code" | Out-File -Append -Encoding utf8 $log
    if ($code -ne 0) { Start-Sleep -Seconds 5 }
}
