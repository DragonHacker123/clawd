# Dev tool: every N seconds, really click Clawd with the mouse and record whether
# the press reached him. Safe: it only clicks if Windows says the point under his
# body belongs to Clawd's window (so a click can never land on the app beneath);
# otherwise it records the failure without clicking. Restores your cursor after,
# and skips a round while you're holding the left button.
# usage: powershell -File tools/click-monitor.ps1 [-Rounds 80] [-Every 30]
param([int]$Rounds = 80, [int]$Every = 30)

Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
}
"@
[M]::SetProcessDPIAware() | Out-Null
$token = (Get-Content "$env:APPDATA\clawd-desktop\token.txt").Trim()
$H = @{ 'X-Clawd-Token' = $token }
$base = 'http://127.0.0.1:47321'
$started = Get-Date

for ($i = 1; $i -le $Rounds; $i++) {
  $stamp = Get-Date -Format 'HH:mm:ss'
  $mins = [Math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  try {
    if ([M]::GetAsyncKeyState(1) -band 0x8000) { "$stamp (+$mins min) skipped: you're holding the mouse"; Start-Sleep $Every; continue }
    $ph = Invoke-RestMethod -Uri "$base/debug/physics" -Headers $H
    if (-not $ph.visible) { "$stamp (+$mins min) skipped: Clawd hidden"; Start-Sleep $Every; continue }
    $hb = $ph.hitbox
    $x = [int]($ph.x + ($hb.x0 + $hb.x1) / 2); $y = [int]($ph.y + ($hb.y0 + $hb.y1) / 2)
    $saved = New-Object M+P; [M]::GetCursorPos([ref]$saved) | Out-Null
    [M]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 150
    $p = New-Object M+P; $p.X = $x; $p.Y = $y
    $hwnd = [M]::GetAncestor([M]::WindowFromPoint($p), 2)
    $procId = 0; [M]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $owner = (Get-Process -Id $procId).ProcessName
    $ex = '{0:X}' -f [M]::GetWindowLong($hwnd, -20)
    $state = Invoke-RestMethod -Uri "$base/debug/clicks" -Headers $H
    if ($owner -ne 'electron') {
      [M]::SetCursorPos($saved.X, $saved.Y) | Out-Null
      "$stamp (+$mins min) BROKEN-HITTEST: point under him belongs to $owner (ex=$ex); Clawd interactive=$($state.interactive) anim=$($state.anim) mode=$($state.mode)"
    } else {
      $clickedAt = (Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
      [M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # left down
      Start-Sleep -Milliseconds 60
      [M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # left up
      Start-Sleep -Milliseconds 300
      [M]::SetCursorPos($saved.X, $saved.Y) | Out-Null
      $after = Invoke-RestMethod -Uri "$base/debug/clicks" -Headers $H
      $pressed = @($after.log | Where-Object { $_ -match ' press ' -and $_.Substring(0, 12) -ge $clickedAt }).Count -gt 0
      if ($pressed) { "$stamp (+$mins min) ok: press reached him (anim=$($state.anim) mode=$($state.mode))" }
      else { "$stamp (+$mins min) BROKEN-DELIVERY: Windows says Clawd owns the point (ex=$ex) but no press reached the page; interactive=$($state.interactive) anim=$($state.anim) mode=$($state.mode)" }
    }
  } catch {
    "$stamp (+$mins min) error: $($_.Exception.Message)"
  }
  Start-Sleep $Every
}
