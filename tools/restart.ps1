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
  Start-Process -FilePath $exe -ArgumentList "`"$root`"" -WorkingDirectory $root
  Start-Sleep -Seconds 4
  Write-Output "restarted"
}
