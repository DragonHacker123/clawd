# Dev helper: screenshot just the pet window's area of the screen (including
# layered/transparent windows, which need BitBlt with CAPTUREBLT).
param([string]$Out = "$env:TEMP\clawd-snap.png", [int]$Scale = 2)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int op);
  public struct R { public int L, T, Rt, B; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process electron | Where-Object { $_.Path -like 'C:\claude projects\clawd\*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no pet window"; exit 1 }
$r = New-Object W+R; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc(); $screen = [W]::GetDC([IntPtr]::Zero)
[W]::BitBlt($hdc, 0, 0, $w, $h, $screen, $r.L, $r.T, 0x00CC0020 -bor 0x40000000) | Out-Null
[W]::ReleaseDC([IntPtr]::Zero, $screen) | Out-Null; $g.ReleaseHdc($hdc)
$big = New-Object System.Drawing.Bitmap ($w * $Scale), ($h * $Scale)
$g2 = [System.Drawing.Graphics]::FromImage($big); $g2.InterpolationMode = 'NearestNeighbor'; $g2.PixelOffsetMode = 'Half'
$g2.DrawImage($bmp, 0, 0, $w * $Scale, $h * $Scale)
$big.Save($Out); Write-Output "$Out ($($r.L),$($r.T) ${w}x$h)"
