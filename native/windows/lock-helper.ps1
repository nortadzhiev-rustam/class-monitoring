# Keyboard and mouse lock for Windows student computers, run while the lock
# screen or the teacher's screen is up (see src/student/input-lock.ts).
# Low-level hooks swallow the student's keys and mouse, including the Windows
# key, Alt+Tab and Ctrl+Esc, and the taskbar is hidden on every monitor.
# Ctrl+Alt+Del can't be blocked: Windows keeps it for itself. Input that
# input-helper.ps1 sends for remote control is tagged and still gets through.
#
# Runs until stdin closes: ClassMonitor closes it when the lock ends, and it
# also closes when ClassMonitor quits or crashes. Either way the hooks go and
# the taskbar comes back.
#
# -DryRun prints "locked" / "unlocked" without touching input or the taskbar.
# -Restore just shows any hidden taskbar again (at startup, after a crash).

param([switch]$DryRun, [switch]$Restore)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class ClassMonitorLock {
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);

    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string cls, string title);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, SW_HIDE = 0, SW_SHOWNA = 8;
    const uint WM_QUIT = 0x0012;
    /// The tag input-helper.ps1 puts on remote-control input (dwExtraInfo).
    static readonly IntPtr Mark = new IntPtr(0x434D4F4E);
    static readonly IntPtr Swallow = new IntPtr(1);

    // Held in fields so the garbage collector never frees a callback Windows still calls.
    static readonly HookProc keyboardProc = OnKeyboard;
    static readonly HookProc mouseProc = OnMouse;
    static readonly List<IntPtr> hiddenTaskbars = new List<IntPtr>();
    static uint loopThread;

    static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if (info.dwExtraInfo != Mark) return Swallow;
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0) {
            var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if (info.dwExtraInfo != Mark) return Swallow;
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    /// The taskbar on the main monitor, then the ones on other monitors.
    static List<IntPtr> Taskbars() {
        var bars = new List<IntPtr>();
        IntPtr main = FindWindow("Shell_TrayWnd", null);
        if (main != IntPtr.Zero) bars.Add(main);
        IntPtr other = IntPtr.Zero;
        while ((other = FindWindowEx(IntPtr.Zero, other, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) bars.Add(other);
        return bars;
    }

    /// Shows every hidden taskbar (one a crashed lock may have left hidden).
    public static void RestoreTaskbars() {
        foreach (IntPtr bar in Taskbars()) if (!IsWindowVisible(bar)) ShowWindow(bar, SW_SHOWNA);
    }

    /// Swallows the keyboard and mouse and hides the taskbar until stdin closes.
    public static void Run(bool dryRun) {
        MSG msg;
        loopThread = GetCurrentThreadId();
        // Gives this thread its message queue now, so the reader's WM_QUIT can't get lost.
        PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
        IntPtr keyboardHook = IntPtr.Zero, mouseHook = IntPtr.Zero;
        if (!dryRun) {
            IntPtr module = GetModuleHandle(null);
            keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
            if (keyboardHook == IntPtr.Zero) Console.Error.WriteLine("Could not hook the keyboard: error " + Marshal.GetLastWin32Error());
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
            if (mouseHook == IntPtr.Zero) Console.Error.WriteLine("Could not hook the mouse: error " + Marshal.GetLastWin32Error());
            foreach (IntPtr bar in Taskbars()) {
                if (!IsWindowVisible(bar)) continue;
                ShowWindow(bar, SW_HIDE);
                hiddenTaskbars.Add(bar);
            }
        }
        Console.WriteLine("locked");

        var reader = new Thread(delegate () {
            while (Console.In.ReadLine() != null) { }
            PostThreadMessage(loopThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        });
        reader.IsBackground = true;
        reader.Start();
        try {
            // The hook callbacks run inside this loop, which ends on the reader's WM_QUIT.
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        } finally {
            if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
            foreach (IntPtr bar in hiddenTaskbars) ShowWindow(bar, SW_SHOWNA);
            hiddenTaskbars.Clear();
            Console.WriteLine("unlocked");
        }
    }
}
'@

if ($Restore) {
    if (-not $DryRun) { [ClassMonitorLock]::RestoreTaskbars() }
    exit 0
}
[ClassMonitorLock]::Run([bool]$DryRun)
