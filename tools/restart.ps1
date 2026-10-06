# Dev helper: restart the running Clawd. Kills the main electron process for this
# folder plus any orphaned child processes (whose parent is gone), then relaunches.
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq $exe }
foreach ($p in $procs) {
  $isMain = $p.CommandLine -notmatch '--type='
  $orphan = -not (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue)
  if ($isMain -or $orphan) { Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
Get-Process fgwatch -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
if ($args -notcontains '-StopOnly') {
  # Launch through WMI so Clawd isn't a child of whatever ran this script. Run from
  # a Claude Code session, Start-Process would put him in the Claude app's job
  # object, and he'd be killed whenever the app restarts or updates.
  $cmd = "`"$exe`" `"$root`""
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
  if ($r.ReturnValue -ne 0) { Start-Process -FilePath $exe -ArgumentList "`"$root`"" -WorkingDirectory $root }
  Start-Sleep -Seconds 4
  Write-Output "restarted"
}
