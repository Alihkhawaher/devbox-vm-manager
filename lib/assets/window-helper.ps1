# devbox VM Manager - the window of a QEMU process (lib/wincap.js starts it;
# nothing else does). An appliance VM shown in a window on this PC (display
# "window", lib/appliance.js) has no VNC server, and QEMU's screendump cannot
# read a 3D (GL) screen ("no surface").
#
# -Action capture: a picture of the window. PrintWindow with
#   PW_RENDERFULLCONTENT asks Windows' compositor for the window's content, GL
#   and Direct3D included, also when other windows cover it. A minimized window
#   has no content: it is restored without taking the focus, captured, and
#   minimized again. The picture is the client area (the guest screen, below
#   QEMU's own menu bar) as a binary PPM (P6) - the format QEMU's screendump
#   writes, so lib/screen.js handles both alike.
#     powershell -File window-helper.ps1 -Action capture -ProcessId 1234 -Out C:\...\shot.ppm [-CacheDir C:\...]
#     -> {"ok":true,"width":1280,"height":800,"restored":false,"title":"QEMU (kodi)"}
# -Action fit: give the window a client area of -Width x -Height (QEMU's GTK
#   window opens at the firmware's 640x480 and, zooming to fit, keeps that
#   size), at most 90 % of the monitor's work area, centred on it - without
#   taking the focus. Waits up to -WaitMs for the window to appear. In the
#   window's own (DPI-virtualized) units, like the window itself.
#     -> {"ok":true,"width":1280,"height":828}
# Failures: {"ok":false,"error":"..."}
#
# The C# part is compiled once into <CacheDir>\devbox-wincap-<hash>.dll and
# loaded from there afterwards (compiling takes about a second).

param([string]$Action = 'capture', [int]$ProcessId, [string]$Out, [string]$CacheDir,
      [int]$Width = 1280, [int]$Height = 800, [int]$WaitMs = 10000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Send($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

$src = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class DevboxWinCap {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    const int SW_SHOWNOACTIVATE = 4, SW_SHOWMINNOACTIVE = 7;
    const uint PW_RENDERFULLCONTENT = 2, MONITOR_DEFAULTTONEAREST = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10;

    // The process's biggest visible top-level window (QEMU's main window).
    static IntPtr FindMain(int pid) {
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        EnumWindows(delegate (IntPtr h, IntPtr p) {
            uint wp;
            GetWindowThreadProcessId(h, out wp);
            if (wp == (uint)pid && IsWindowVisible(h)) {
                RECT r;
                GetWindowRect(h, out r);
                long a = (long)(r.R - r.L) * (long)(r.B - r.T);
                if (a > bestArea) { bestArea = a; best = h; }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // "<client width>x<client height>", or "minimized" (left alone)
    public static string Fit(int pid, int w, int h, int waitMs) {
        IntPtr win = IntPtr.Zero;
        for (int waited = 0; ; waited += 200) {
            win = FindMain(pid);
            if (win != IntPtr.Zero || waited >= waitMs) break;
            System.Threading.Thread.Sleep(200);
        }
        if (win == IntPtr.Zero) throw new Exception("process " + pid + " has no visible window");
        if (IsIconic(win)) return "minimized";
        RECT wr, cr;
        GetWindowRect(win, out wr);
        GetClientRect(win, out cr);
        int fw = (wr.R - wr.L) - (cr.R - cr.L), fh = (wr.B - wr.T) - (cr.B - cr.T);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(win, MONITOR_DEFAULTTONEAREST), ref mi)) throw new Exception("no monitor for the window");
        int aw = mi.rcWork.R - mi.rcWork.L, ah = mi.rcWork.B - mi.rcWork.T;
        double k = Math.Min(1.0, Math.Min((aw * 0.9 - fw) / w, (ah * 0.9 - fh) / h));
        if (k <= 0.1) k = 0.1;
        int cw = (int)(w * k), ch = (int)(h * k);
        int tw = cw + fw, th = ch + fh;
        int x = mi.rcWork.L + (aw - tw) / 2, y = mi.rcWork.T + (ah - th) / 2;
        if (!SetWindowPos(win, IntPtr.Zero, x, y, tw, th, SWP_NOZORDER | SWP_NOACTIVATE)) throw new Exception("SetWindowPos failed");
        return cw + "x" + ch;
    }

    // "<width>x<height>|<restored 0/1>|<title>"
    public static string Capture(int pid, string outPath) {
        SetProcessDPIAware();   // physical pixels, also on a scaled display
        IntPtr best = FindMain(pid);
        if (best == IntPtr.Zero) throw new Exception("process " + pid + " has no visible window");
        bool restored = false;
        if (IsIconic(best)) {
            ShowWindow(best, SW_SHOWNOACTIVATE);
            restored = true;
            System.Threading.Thread.Sleep(600);   // let it draw a frame
        }
        try {
            RECT wr, cr;
            GetWindowRect(best, out wr);
            GetClientRect(best, out cr);
            POINT o = new POINT();
            ClientToScreen(best, ref o);
            int ww = wr.R - wr.L, wh = wr.B - wr.T, cw = cr.R - cr.L, ch = cr.B - cr.T;
            if (ww < 8 || wh < 8 || cw < 8 || ch < 8) throw new Exception("the window is too small to capture (" + cw + "x" + ch + ")");
            using (Bitmap full = new Bitmap(ww, wh, PixelFormat.Format32bppArgb)) {
                using (Graphics g = Graphics.FromImage(full)) {
                    IntPtr dc = g.GetHdc();
                    try { if (!PrintWindow(best, dc, PW_RENDERFULLCONTENT)) throw new Exception("PrintWindow failed"); }
                    finally { g.ReleaseHdc(dc); }
                }
                Rectangle rect = new Rectangle(o.X - wr.L, o.Y - wr.T, cw, ch);
                rect.Intersect(new Rectangle(0, 0, ww, wh));
                if (rect.Width < 8 || rect.Height < 8) throw new Exception("the window's client area is outside the window");
                BitmapData bd = full.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try {
                    int w = bd.Width, h = bd.Height, stride = bd.Stride;
                    byte[] src = new byte[stride * h];
                    Marshal.Copy(bd.Scan0, src, 0, src.Length);
                    byte[] px = new byte[w * h * 3];
                    for (int y = 0; y < h; y++) {
                        int si = y * stride, di = y * w * 3;
                        for (int x = 0; x < w; x++) {
                            px[di] = src[si + 2]; px[di + 1] = src[si + 1]; px[di + 2] = src[si];
                            si += 4; di += 3;
                        }
                    }
                    byte[] hdr = Encoding.ASCII.GetBytes("P6\n" + w + " " + h + "\n255\n");
                    using (FileStream fs = File.Create(outPath)) {
                        fs.Write(hdr, 0, hdr.Length);
                        fs.Write(px, 0, px.Length);
                    }
                    StringBuilder t = new StringBuilder(256);
                    GetWindowText(best, t, 256);
                    return w + "x" + h + "|" + (restored ? "1" : "0") + "|" + t.ToString();
                } finally { full.UnlockBits(bd); }
            }
        } finally {
            if (restored) ShowWindow(best, SW_SHOWMINNOACTIVE);
        }
    }
}
'@

try {
    Add-Type -AssemblyName System.Drawing
    if (-not ('DevboxWinCap' -as [type])) {
        $loaded = $false
        if ($CacheDir) {
            $sha = [Security.Cryptography.SHA256]::Create()
            $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src)))).Replace('-', '').Substring(0, 16)
            $dll = Join-Path $CacheDir ('devbox-wincap-' + $hash + '.dll')
            try {
                if (-not (Test-Path -LiteralPath $dll)) {
                    $null = New-Item -ItemType Directory -Force -Path $CacheDir
                    # (Add-Type also loads what it compiles to a file)
                    Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing -OutputAssembly $dll -OutputType Library
                }
                if (-not ('DevboxWinCap' -as [type])) { Add-Type -LiteralPath $dll }
                $loaded = ('DevboxWinCap' -as [type]) -ne $null
            } catch {
                $loaded = ('DevboxWinCap' -as [type]) -ne $null
                # a broken cache file (a capture killed while compiling): compiled afresh next time
                if (-not $loaded) { try { Remove-Item -LiteralPath $dll -Force -ErrorAction Stop } catch { } }
            }
        }
        if (-not $loaded) { Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing }
    }
    if ($Action -eq 'fit') {
        $r = [DevboxWinCap]::Fit($ProcessId, $Width, $Height, $WaitMs)
        if ($r -eq 'minimized') { Send ([ordered]@{ ok = $true; minimized = $true }) }
        else { $wh = $r.Split([char]'x'); Send ([ordered]@{ ok = $true; width = [int]$wh[0]; height = [int]$wh[1] }) }
    } elseif ($Action -eq 'capture') {
        $r = [DevboxWinCap]::Capture($ProcessId, [IO.Path]::GetFullPath($Out))
        $parts = $r.Split([char]'|', 3)
        $wh = $parts[0].Split([char]'x')
        Send ([ordered]@{ ok = $true; width = [int]$wh[0]; height = [int]$wh[1]; restored = ($parts[1] -eq '1'); title = $parts[2] })
    } else { throw ('unknown action: ' + $Action) }
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Send ([ordered]@{ ok = $false; error = $e.Message })
}
