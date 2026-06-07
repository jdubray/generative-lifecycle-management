<#
.SYNOPSIS
  Register (or refresh) the "GLM Server" always-on scheduled task.

.DESCRIPTION
  Creates a Windows Scheduled Task that runs the GLM HTTP server hidden, as the
  current user, at logon - no admin rights and no stored password required. The
  task's action is the self-reaping PowerShell supervisor
  (scripts/glm-server-supervisor.ps1), which keeps bun alive and guarantees a
  clean Stop-then-Start restart (see that file's header for why).

  The task definition lives only in Task Scheduler, not in git, so run this once
  per machine (or after a rebuild) to recreate it. Idempotent: -Force replaces an
  existing task of the same name.

.PARAMETER TaskName
  Scheduled task name. Default: "GLM Server".

.PARAMETER Start
  Start the task immediately after registering and wait for the health endpoint.

.EXAMPLE
  pwsh -File scripts/install-service.ps1 -Start
#>
[CmdletBinding()]
param(
  [string] $TaskName = 'GLM Server',
  [switch] $Start
)

$ErrorActionPreference = 'Stop'

# Self-locating: this script lives in scripts/, so the repo root is its parent.
$repo = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $repo 'scripts\glm-server-supervisor.ps1'
if (-not (Test-Path $supervisor)) {
  throw "supervisor not found at $supervisor - run from a full checkout."
}

# Read PORT from .env (for the post-start health check); default 3300.
$port = 3300
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}

Write-Host "Registering task '$TaskName'"
Write-Host "  supervisor : $supervisor"
Write-Host "  runs as    : $env:USERDOMAIN\$env:USERNAME (at logon, hidden, no password)"
Write-Host "  health     : http://localhost:$port/api/v1/health"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $supervisor)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description 'Always-on GLM server (Bun). PowerShell supervisor reaps stale instances on start so Stop-then-Start restarts cleanly.' | Out-Null

Write-Host "Registered." -ForegroundColor Green

if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started; waiting for health..."
  $up = $false
  foreach ($i in 1..30) {
    try { Invoke-WebRequest "http://localhost:$port/api/v1/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break }
    catch { Start-Sleep -Milliseconds 800 }
  }
  if ($up) { Write-Host "GLM server is up on :$port" -ForegroundColor Green }
  else { Write-Warning "GLM server did not answer on :$port yet - check logs/glm-supervisor.log and logs/glm-server.err.log" }
}
else {
  Write-Host "Run it with:  Start-ScheduledTask -TaskName '$TaskName'"
}
