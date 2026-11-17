# Website rules without the browser extension (see src/student/web-watch.ts):
# reads the address bar of every Chrome, Edge, Firefox, Brave, Vivaldi and
# Opera window through UI Automation, and sends a window's tab to another
# address when ClassMonitor asks. Runs as the logged-in student, so it only
# sees and touches that student's own windows.
#
# One command per line on stdin, one JSON answer per line on stdout:
#   scan               -> {"readable":true,"tabs":[{"window":"132456","address":"youtube.com/watch?v=1",
#                           "title":"YouTube - Google Chrome","front":true,"editing":false}]}
#   open <hwnd> <url>  -> {"opened":"132456","how":"address"}  (or "closed-tab", "closed", "failed")
# "readable" is false when a browser window is open but no address bar could be found in any.
# Exits when stdin closes.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ClassMonitorBrowsers {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const uint KEYUP = 0x0002;
    const int SW_RESTORE = 9;

    /// Presses the keys together, then lets go in reverse order (e.g. Ctrl+L).
    public static void Press(params byte[] keys) {
        foreach (byte k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, KEYUP, UIntPtr.Zero);
    }

    /// Brings the window to the front. Windows only lets the app the student is
    /// using choose the foreground window; a tap of Alt counts as input of ours.
    public static bool Activate(IntPtr hwnd) {
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        if (GetForegroundWindow() == hwnd) return true;
        Press(0x12);
        SetForegroundWindow(hwnd);
        return GetForegroundWindow() == hwnd;
    }
}
'@

# UTF-8 without a byte-order mark, so page titles in any language arrive intact.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$Element = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$ValuePattern = [System.Windows.Automation.ValuePattern]::Pattern
$WindowPattern = [System.Windows.Automation.WindowPattern]::Pattern

# Chromium browsers' windows, and Firefox's.
$windowCondition = [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]@(
    [System.Windows.Automation.PropertyCondition]::new($Element::ClassNameProperty, 'Chrome_WidgetWin_1'),
    [System.Windows.Automation.PropertyCondition]::new($Element::ClassNameProperty, 'MozillaWindowClass')
))
# The address bar is the first text box in a window, ahead of the page's own.
$editCondition = [System.Windows.Automation.PropertyCondition]::new($Element::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$firefoxBarCondition = [System.Windows.Automation.PropertyCondition]::new($Element::AutomationIdProperty, 'urlbar-input')
# Electron apps (Teams, VS Code, ClassMonitor itself) use Chrome's window class too: only these programs count.
$browsers = @('chrome', 'msedge', 'firefox', 'brave', 'vivaldi', 'opera', 'chromium')

$processNames = @{}  # process id -> name
$windows = @{}       # window handle -> window, from the last scan
$bars = @{}          # window handle -> its address bar
$noBar = @{}         # window handle -> scans left before looking for its address bar again
$scans = 0

function ProcessName([int]$id) {
    if (-not $processNames.ContainsKey($id)) {
        $name = ''
        try { $name = (Get-Process -Id $id).ProcessName.ToLowerInvariant() } catch {}
        $processNames[$id] = $name
    }
    return $processNames[$id]
}

function AddressBar($window, [string]$hwnd, [string]$name) {
    $bar = $bars[$hwnd]
    if ($bar) {
        try { $null = $bar.Current.ControlType; return $bar } catch { $bars.Remove($hwnd) }
    }
    # Pop-ups, DevTools and app windows have none; don't search them every second.
    if ($noBar.ContainsKey($hwnd) -and $noBar[$hwnd] -gt 0) { $noBar[$hwnd]--; return $null }
    $bar = $null
    if ($name -eq 'firefox') { $bar = $window.FindFirst($Scope::Descendants, $firefoxBarCondition) }
    if (-not $bar) { $bar = $window.FindFirst($Scope::Descendants, $editCondition) }
    if ($bar) { $bars[$hwnd] = $bar; $noBar.Remove($hwnd) } else { $noBar[$hwnd] = 10 }
    return $bar
}

function Scan {
    $script:scans++
    # Process ids get reused: forget the names now and then.
    if ($script:scans % 60 -eq 0) { $processNames.Clear() }
    $front = [string][ClassMonitorBrowsers]::GetForegroundWindow().ToInt64()
    $tabs = New-Object System.Collections.ArrayList
    $titled = 0
    $seen = @{}
    foreach ($window in $Element::RootElement.FindAll($Scope::Children, $windowCondition)) {
        try {
            $current = $window.Current
            $name = ProcessName $current.ProcessId
            if ($browsers -notcontains $name) { continue }
            # Chrome's menus, tooltips and hidden helper windows have no title.
            $title = $current.Name
            if (-not $title) { continue }
            $hwnd = [string]$current.NativeWindowHandle
            $seen[$hwnd] = $true
            $windows[$hwnd] = $window
            $titled++
            $bar = AddressBar $window $hwnd $name
            if (-not $bar) { continue }
            $value = $bar.GetCurrentPattern($ValuePattern).Current.Value
            [void]$tabs.Add([ordered]@{
                window = $hwnd
                address = $value
                title = $title
                front = ($hwnd -eq $front)
                editing = $bar.Current.HasKeyboardFocus
            })
        } catch {
            # The window closed while we looked at it.
        }
    }
    foreach ($key in @($windows.Keys)) {
        if (-not $seen.ContainsKey($key)) { $windows.Remove($key); $bars.Remove($key); $noBar.Remove($key) }
    }
    return [ordered]@{ readable = (($tabs.Count -gt 0) -or ($titled -eq 0)); tabs = $tabs.ToArray() }
}

function Open([string]$hwnd, [string]$url) {
    $window = $windows[$hwnd]
    $bar = $bars[$hwnd]
    if (-not $window -or -not $bar) { return 'failed' }
    if (-not [ClassMonitorBrowsers]::Activate([IntPtr][long]$hwnd)) {
        # It can't come to the front to change its address: close that window instead.
        try { $window.GetCurrentPattern($WindowPattern).Close(); return 'closed' } catch { return 'failed' }
    }
    try {
        try { $bar.SetFocus() } catch {}
        if (-not $bar.Current.HasKeyboardFocus) {
            [ClassMonitorBrowsers]::Press(0x11, 0x4C)  # Ctrl+L: every browser's "go to the address bar"
            Start-Sleep -Milliseconds 150
        }
        if ($bar.Current.HasKeyboardFocus) {
            $bar.GetCurrentPattern($ValuePattern).SetValue($url)
            Start-Sleep -Milliseconds 50
            [ClassMonitorBrowsers]::Press(0x0D)  # Enter
            return 'address'
        }
    } catch {}
    # The address can't be typed in this window: close the tab (Ctrl+W), which is the one on screen.
    [ClassMonitorBrowsers]::Press(0x11, 0x57)
    return 'closed-tab'
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Trim() -split ' ', 3
    if ($parts[0] -eq 'scan') {
        try { $answer = Scan } catch { $answer = [ordered]@{ readable = $false; tabs = @(); error = $_.Exception.Message } }
    } elseif ($parts[0] -eq 'open' -and $parts.Count -eq 3) {
        $how = 'failed'
        try { $how = Open $parts[1] $parts[2] } catch {}
        $answer = [ordered]@{ opened = $parts[1]; how = $how }
    } else {
        continue
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $answer -Compress -Depth 4))
    [Console]::Out.Flush()
}
