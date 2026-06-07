# GLM server supervisor for the "GLM Server" scheduled task.
#
# Runs as the task's DIRECT action (powershell.exe -File ...), hidden, and keeps
# bun alive with a restart loop. bun auto-loads .env (PORT 3300, GLM_SOLO_TOKEN).
#
# Clean-restart strategy: Windows Task Scheduler runs each task inside its OWN
# job object, which makes it kill the launcher (this powershell) but orphan the
# bun child on Stop — and a Job Object of our own can't adopt bun (Assign fails
# with ACCESS_DENIED under TS's job). So instead of trying to die-together, every
# supervisor REAPS any prior GLM server on startup. Net effect:
#   * Restart (Stop then Start) is always clean — the new supervisor kills the
#     orphan the old Stop left behind, then starts fresh code on a free :3300.
#   * No instance accumulation, ever (this replaces the bug where repeated Stops
#     piled up zombie launchers all fighting for the port).
# A bare Stop (with no following Start) leaves one harmless orphan; it is reaped
# the next time the task starts. To force a hard stop without restart, run:
#   Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'server[\\/]server\.ts' } | % { Stop-Process $_.ProcessId -Force }

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logDir = Join-Path $repo 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$outLog  = Join-Path $logDir 'glm-server.log'
$errLog  = Join-Path $logDir 'glm-server.err.log'
$lifeLog = Join-Path $logDir 'glm-supervisor.log'

function Write-Life($msg) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $msg | Out-File -Append -FilePath $lifeLog
}

# --- Reap any prior GLM server bun this supervisor didn't start --------------
$stale = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'src[\\/]server[\\/]server\.ts' -and $_.ProcessId -ne $PID
}
foreach ($s in $stale) {
  Write-Life "reaping stale GLM server PID $($s.ProcessId)"
  Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($stale) { Start-Sleep -Seconds 1 }

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }

Write-Life "supervisor started (PID $PID, bun=$bun)"
while ($true) {
  Write-Life 'starting GLM server'
  $p = Start-Process -FilePath $bun -ArgumentList 'run', 'src/server/server.ts' `
    -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $p.WaitForExit()
  Write-Life ("GLM server exited (code {0}); restarting in 5s" -f $p.ExitCode)
  Start-Sleep -Seconds 5
}
