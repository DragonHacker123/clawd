// Tiny helper for Clawd. Prints JSON lines to stdout:
//  - every 150 ms, when it changes: which app is in the foreground, where the
//    Claude desktop app's main window is, and the windows stacked above it
//    (so Clawd hides only when something actually covers him);
//  - {"input":"key"} / {"input":"link"} / {"input":"scroll"} when you type,
//    click a link (hand cursor) or scroll, while Claude is in front — only THAT it happened, never which key
//    — so Clawd can wake up. Throttled to one per 700 ms.
// Built on first run with the .NET Framework's csc.exe (see src/foreground.js).
// Exits when stdin closes (Clawd quit).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class FgWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int n);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr inst, int id);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

  delegate bool EnumProc(IntPtr h, IntPtr p);
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  struct RECT { public int L, T, R, B; }
  struct POINT { public int X, Y; }
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr w, l; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)]
  struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }

  static readonly object outLock = new object();
  static void Emit(string line) {
    lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static readonly Dictionary<uint, string> exeCache = new Dictionary<uint, string>();
  static string ExeOf(uint pid) {
    string cached;
    if (exeCache.TryGetValue(pid, out cached)) return cached;
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    string path = "";
    if (h != IntPtr.Zero) {
      var sb = new StringBuilder(1024);
      int n = sb.Capacity;
      if (QueryFullProcessImageName(h, 0, sb, ref n)) path = sb.ToString();
      CloseHandle(h);
    }
    if (exeCache.Count > 500) exeCache.Clear();
    exeCache[pid] = path;
    return path;
  }

  static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static bool IsClaude(string exe) {
    return Path.GetFileName(exe).Equals("claude.exe", StringComparison.OrdinalIgnoreCase)
      && exe.IndexOf(@"\.local\bin\", StringComparison.OrdinalIgnoreCase) < 0;
  }

  static string selfDir;
  static bool debug;
  static bool IsSelf(string exe) {
    return selfDir != null && exe.StartsWith(selfDir, StringComparison.OrdinalIgnoreCase);
  }

  static readonly HashSet<string> shellClasses = new HashSet<string> {
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    "#32768", "Progman", "WorkerW",
  };

  static string Kind(IntPtr fg) {
    if (fg == IntPtr.Zero) return "none";
    uint pid;
    GetWindowThreadProcessId(fg, out pid);
    string exe = ExeOf(pid);
    if (IsClaude(exe)) return "claude";
    if (IsSelf(exe)) return "self";
    if (shellClasses.Contains(ClassOf(fg))) return "tray";
    return "other";
  }

  static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); // DWMWA_EXTENDED_FRAME_BOUNDS
    return r;
  }

  static bool Cloaked(IntPtr h) {
    int cloaked;
    return DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0; // DWMWA_CLOAKED
  }

  // The main taskbar's rectangle in physical pixels. When it auto-hides it
  // slides mostly off-screen but keeps its height, which is what Clawd needs
  // to stay clear of the spot where it pops back up.
  static string Tray() {
    IntPtr h = FindWindow("Shell_TrayWnd", null);
    if (h == IntPtr.Zero) return "\"tray\":null";
    RECT r;
    if (!GetWindowRect(h, out r)) return "\"tray\":null";
    return "\"tray\":[" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T) + "]";
  }

  // One pass over top-level windows in z-order (top first): find Claude's main
  // window and every ordinary window stacked above it.
  static string Scan() {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    RECT bestRect = new RECT();
    var above = new List<RECT>();
    var aboveSoFar = new List<RECT>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h) || Cloaked(h) || IsIconic(h)) {
        if (IsWindowVisible(h) && IsIconic(h)) {
          uint ipid; GetWindowThreadProcessId(h, out ipid);
          if (IsClaude(ExeOf(ipid)) && bestArea == 0) { bestArea = 1; best = h; bestRect = Bounds(h); }
        }
        return true;
      }
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string exe = ExeOf(pid);
      RECT r = Bounds(h);
      if (IsClaude(exe) && GetWindow(h, 4) == IntPtr.Zero) { // GW_OWNER: skip owned popups
        long area = (long)(r.R - r.L) * (r.B - r.T);
        if (area > bestArea) {
          bestArea = area; best = h; bestRect = r;
          above = new List<RECT>(aboveSoFar);
        }
        return true;
      }
      if (IsClaude(exe) || IsSelf(exe) || shellClasses.Contains(ClassOf(h))) return true;
      int ex = GetWindowLong(h, -20); // GWL_EXSTYLE
      if ((ex & 0x20) != 0 || (ex & 0x80) != 0) return true; // WS_EX_TRANSPARENT overlays, WS_EX_TOOLWINDOW
      if (r.R - r.L < 4 || r.B - r.T < 4) return true;
      aboveSoFar.Add(r);
      if (debug) Console.Error.WriteLine("above: " + ClassOf(h) + " | " + exe + " | " + r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T) + " ex=" + ex.ToString("X"));
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return "\"claude\":null,\"above\":[]";
    var sb = new StringBuilder();
    sb.AppendFormat("\"claude\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3},\"min\":{4}}},\"above\":[",
      bestRect.L, bestRect.T, bestRect.R - bestRect.L, bestRect.B - bestRect.T, IsIconic(best) ? "true" : "false");
    for (int i = 0; i < above.Count; i++) {
      var r = above[i];
      if (i > 0) sb.Append(',');
      sb.AppendFormat("[{0},{1},{2},{3}]", r.L, r.T, r.R - r.L, r.B - r.T);
    }
    sb.Append(']');
    return sb.ToString();
  }

  // ---------- input (only that it happened, only while Claude is in front) ----------

  static volatile bool claudeInFront;
  static long lastInputTicks;
  static HookProc keyProc, mouseProc; // keep delegates alive
  static IntPtr handCursor;

  static long lastScrollTicks;
  static void Signal(string kind) {
    long now = Environment.TickCount;
    if (kind == "scroll") {
      if (now - Interlocked.Read(ref lastScrollTicks) < 400) return;
      Interlocked.Exchange(ref lastScrollTicks, now);
    } else {
      if (now - Interlocked.Read(ref lastInputTicks) < 700) return;
      Interlocked.Exchange(ref lastInputTicks, now);
    }
    ThreadPool.QueueUserWorkItem(_ => Emit("{\"input\":\"" + kind + "\"}"));
  }

  static void HookThread() {
    handCursor = LoadCursor(IntPtr.Zero, 32649); // IDC_HAND
    IntPtr mod = GetModuleHandle(null);
    keyProc = (code, w, l) => {
      if (code >= 0 && claudeInFront && (w.ToInt32() == 0x100 || w.ToInt32() == 0x104)) Signal("key"); // WM_(SYS)KEYDOWN
      return CallNextHookEx(IntPtr.Zero, code, w, l);
    };
    mouseProc = (code, w, l) => {
      if (code >= 0 && w.ToInt32() == 0x201) { // WM_LBUTTONDOWN: where (only), so Clawd can tell if a press on him got lost
        int px = Marshal.ReadInt32(l, 0), py = Marshal.ReadInt32(l, 4);
        ThreadPool.QueueUserWorkItem(_ => Emit("{\"down\":[" + px + "," + py + "]}"));
      }
      if (code >= 0 && claudeInFront && w.ToInt32() == 0x201) { // WM_LBUTTONDOWN
        var ci = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
        if (GetCursorInfo(ref ci) && ci.hCursor == handCursor) Signal("link");
      }
      if (code >= 0 && claudeInFront && w.ToInt32() == 0x20A) Signal("scroll"); // WM_MOUSEWHEEL
      return CallNextHookEx(IntPtr.Zero, code, w, l);
    };
    SetWindowsHookEx(13, keyProc, mod, 0);   // WH_KEYBOARD_LL
    SetWindowsHookEx(14, mouseProc, mod, 0); // WH_MOUSE_LL
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }

  static void Main(string[] args) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} // per-monitor v2: physical pixels
    selfDir = args.Length > 0 ? args[0] : null;
    debug = args.Length > 1 && args[1] == "--debug";
    // stdin: "probe <id> <x> <y>" (physical px) -> {"probe":id,"owner":...}: who is
    // really on top at that point (system shell surfaces like notification
    // toasts sit above always-on-top windows and aren't in EnumWindows).
    // EOF on stdin = Clawd quit.
    new Thread(() => {
      try {
        string req;
        while ((req = Console.In.ReadLine()) != null) {
          var parts = req.Split(' ');
          if (parts.Length != 4 || parts[0] != "probe") continue;
          var pt = new POINT { X = int.Parse(parts[2]), Y = int.Parse(parts[3]) };
          IntPtr h = GetAncestor(WindowFromPoint(pt), 2);
          uint pid; GetWindowThreadProcessId(h, out pid);
          string exe = ExeOf(pid);
          string owner = IsSelf(exe) ? "self" : IsClaude(exe) ? "claude" : shellClasses.Contains(ClassOf(h)) ? "tray" : "other";
          Emit("{\"probe\":" + int.Parse(parts[1]) + ",\"owner\":\"" + owner + "\",\"cls\":\"" + ClassOf(h).Replace("\"", "") + "\"}");
        }
      } catch {}
      Environment.Exit(0);
    }) { IsBackground = true }.Start();
    new Thread(HookThread) { IsBackground = true }.Start();
    string last = null;
    long lastCpuTicks = -1;
    DateTime lastCpuAt = DateTime.UtcNow;
    int loops = 0;
    while (true) {
      // Every ~2 s: how busy is the Claude desktop app (all its processes)?
      if (loops++ % 13 == 0) {
        try {
          long ticks = 0;
          foreach (var p in System.Diagnostics.Process.GetProcessesByName("claude")) {
            try { if (IsClaude(ExeOf((uint)p.Id))) ticks += p.TotalProcessorTime.Ticks; } catch {}
            p.Dispose();
          }
          var now = DateTime.UtcNow;
          if (lastCpuTicks >= 0) {
            double pct = (ticks - lastCpuTicks) / (double)(now - lastCpuAt).Ticks * 100.0;
            Emit("{\"appCpu\":" + Math.Max(0, Math.Round(pct, 1)).ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
          }
          lastCpuTicks = ticks;
          lastCpuAt = now;
        } catch {}
      }
      string line;
      try {
        string kind = Kind(GetForegroundWindow());
        claudeInFront = kind == "claude";
        line = "{\"fg\":\"" + kind + "\"," + Scan() + "," + Tray() + "}";
      } catch (Exception e) {
        line = "{\"error\":\"" + e.Message.Replace("\"", "'") + "\"}";
      }
      if (line != last) {
        Emit(line);
        last = line;
      }
      Thread.Sleep(150);
    }
  }
}
