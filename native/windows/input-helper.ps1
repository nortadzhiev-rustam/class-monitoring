# Remote-control input helper for Windows student computers.
# Reads one command per line on stdin (protocol in src/student/input.ts) and
# injects it with SendInput. Runs in the logged-in student's session, so it
# cannot drive elevated (admin) windows or the secure desktop (UAC, Ctrl+Alt+Del).
# Windows drops that input without saying so, so once a second it checks what
# is in front and prints "state secure-desktop", "state elevated" or "state ok"
# when that changes; the teacher is told why their clicks do nothing.
#
# `-DryRun` prints the events instead of injecting them, for testing.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ClassMonitorInput {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint code, uint mapType);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    /// Without this, Windows scales metrics for a DPI-unaware PowerShell and
    /// clicks land in the wrong place on high-DPI screens.
    public static void Init() { SetProcessDPIAware(); }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    const uint KEYUP = 0x0002, EXTENDED = 0x0001;
    static readonly uint[] DOWN = { 0x0002, 0x0020, 0x0008 }; // left, middle, right
    static readonly uint[] UP = { 0x0004, 0x0040, 0x0010 };

    public static bool DryRun;
    /// Tags the input sent here, so lock-helper.ps1 lets remote control through.
    static readonly IntPtr Mark = new IntPtr(0x434D4F4E);
    static readonly HashSet<int> heldButtons = new HashSet<int>();
    static readonly Dictionary<ushort, bool> heldKeys = new Dictionary<ushort, bool>();

    static void Send(INPUT input, string description) {
        if (DryRun) { Say(description); return; }
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT Mouse(int dx, int dy, int data, uint flags) {
        var input = new INPUT { type = INPUT_MOUSE };
        input.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, dwExtraInfo = Mark };
        return input;
    }

    /// Physical pixel -> 0..65535 across the whole virtual desktop (every monitor).
    static int Normalise(double value, int origin, int size) {
        double n = (value - origin) / Math.Max(1, size - 1);
        return (int)Math.Round(Math.Max(0, Math.Min(1, n)) * 65535);
    }

    /// x, y are physical desktop pixels; negative for monitors left of or above the main one.
    public static void Move(double x, double y) {
        int dx = Normalise(x, GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int dy = Normalise(y, GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
        Send(Mouse(dx, dy, 0, MOVE | ABSOLUTE | VIRTUALDESK), "move " + (int)x + " " + (int)y);
    }

    /// NaN coordinates mean "where the pointer is now".
    public static void Button(int button, bool down, double x, double y) {
        if (button < 0 || button > 2) return;
        if (!double.IsNaN(x) && !double.IsNaN(y)) Move(x, y);
        if (down) heldButtons.Add(button); else heldButtons.Remove(button);
        Send(Mouse(0, 0, 0, down ? DOWN[button] : UP[button]), "button " + button + (down ? " down" : " up"));
    }

    public static void Wheel(int dx, int dy) {
        // DOM deltas are pixels, positive = down/right. Windows wheel: 120 per notch, positive = up.
        if (dy != 0) Send(Mouse(0, 0, (int)Math.Round(-dy * 1.2), WHEEL), "wheel " + dy);
        if (dx != 0) Send(Mouse(0, 0, (int)Math.Round(dx * 1.2), HWHEEL), "hwheel " + dx);
    }

    public static void Key(ushort vk, bool down, bool extended) {
        if (down) heldKeys[vk] = extended; else heldKeys.Remove(vk);
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT {
            wVk = vk,
            wScan = (ushort)MapVirtualKey(vk, 0),
            dwFlags = (down ? 0 : KEYUP) | (extended ? EXTENDED : 0),
            dwExtraInfo = Mark,
        };
        Send(input, "key " + vk + (down ? " down" : " up") + (extended ? " ext" : ""));
    }

    public static void ReleaseAll() {
        foreach (var button in new List<int>(heldButtons)) Button(button, false, double.NaN, double.NaN);
        foreach (var key in new List<KeyValuePair<ushort, bool>>(heldKeys)) Key(key.Key, false, key.Value);
    }

    // ------------------------------------------------------------ what input can't reach

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    const uint DESKTOP_READOBJECTS = 0x0001, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x0008;
    const int UOI_NAME = 2, TokenIntegrityLevel = 25;
    static readonly object output = new object();
    static Timer watcher;
    static string lastState = "";
    static int ownIntegrity = -1;
    static uint ownPid;

    /// One line on stdout; the watcher writes from another thread.
    public static void Say(string line) {
        lock (output) { Console.WriteLine(line); Console.Out.Flush(); }
    }

    /// Windows has switched to its secure desktop (a User Account Control prompt, Ctrl+Alt+Del,
    /// the lock screen): nothing in the student's session can see it or send it input.
    static bool OnSecureDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == IntPtr.Zero) return true;
        try {
            var name = new StringBuilder(256);
            int needed;
            if (!GetUserObjectInformation(desktop, UOI_NAME, name, name.Capacity * 2, out needed)) return false;
            return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally {
            CloseDesktop(desktop);
        }
    }

    /// The integrity level of a process (8192 = medium, 12288 = high, i.e. run as administrator), or -1.
    static int IntegrityOf(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return -1;
        try {
            int size;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
            if (size <= 0) return -1;
            IntPtr info = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, TokenIntegrityLevel, info, size, out size)) return -1;
                IntPtr sid = Marshal.ReadIntPtr(info); // TOKEN_MANDATORY_LABEL.Label.Sid
                int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return count > 0 ? Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))) : -1;
            } finally {
                Marshal.FreeHGlobal(info);
            }
        } finally {
            CloseHandle(token);
        }
    }

    /// The window in front belongs to a program running as administrator (or as another
    /// account): Windows drops the keys and clicks this helper sends it (UIPI).
    static bool ForegroundElevated() {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return false;
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid == 0 || pid == ownPid || ownIntegrity < 0) return false;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        // The student's own programs can always be looked at; one that can't runs as someone else.
        if (process == IntPtr.Zero) return true;
        try {
            int theirs = IntegrityOf(process);
            return theirs < 0 || theirs > ownIntegrity;
        } finally {
            CloseHandle(process);
        }
    }

    static void Check(object unused) {
        // An exception on this timer thread would end the helper, and remote control with it.
        try {
            string state = OnSecureDesktop() ? "secure-desktop" : ForegroundElevated() ? "elevated" : "ok";
            if (state == lastState) return;
            lastState = state;
            Say("state " + state);
        } catch (Exception) {
            // Nothing to report this time, or nobody is listening any more.
        }
    }

    /// Starts checking once a second what is in front of the student.
    public static void Watch() {
        ownPid = (uint)Process.GetCurrentProcess().Id;
        ownIntegrity = IntegrityOf(GetCurrentProcess());
        watcher = new Timer(Check, null, 0, 1000);
    }
}
'@

[ClassMonitorInput]::DryRun = [bool]$DryRun
[ClassMonitorInput]::Init()
[ClassMonitorInput]::Watch()
$culture = [Globalization.CultureInfo]::InvariantCulture

function Num([string[]]$parts, [int]$i) {
    $value = 0.0
    if ($i -lt $parts.Length -and [double]::TryParse($parts[$i], [Globalization.NumberStyles]::Float, $culture, [ref]$value) -and
        -not [double]::IsNaN($value) -and -not [double]::IsInfinity($value)) {
        return [Math]::Max(-1000000, [Math]::Min(1000000, $value))
    }
    return 0.0
}

$stdin = [Console]::In
while ($null -ne ($line = $stdin.ReadLine())) {
    $p = $line.Split(' ')
    switch ($p[0]) {
        'm' { [ClassMonitorInput]::Move((Num $p 1), (Num $p 2)) }
        'b' {
            # "- -" instead of coordinates: click where the pointer already is.
            $here = $p.Length -gt 3 -and $p[3] -eq '-'
            $x = if ($here) { [double]::NaN } else { Num $p 3 }
            $y = if ($here) { [double]::NaN } else { Num $p 4 }
            [ClassMonitorInput]::Button([int](Num $p 1), (Num $p 2) -eq 1, $x, $y)
        }
        'w' { [ClassMonitorInput]::Wheel([int](Num $p 1), [int](Num $p 2)) }
        'k' { [ClassMonitorInput]::Key([uint16][Math]::Max(0, [Math]::Min(255, (Num $p 1))), (Num $p 2) -eq 1, (Num $p 3) -eq 1) }
        'r' { [ClassMonitorInput]::ReleaseAll() }
    }
}
[ClassMonitorInput]::ReleaseAll()
