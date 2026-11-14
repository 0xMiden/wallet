param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_-]{1,32}$')][string]$ExpectedUser)
$ErrorActionPreference = 'Stop'
if ([Environment]::UserName -ine $ExpectedUser) { throw 'Unexpected Windows user; no observation performed' }
$root = Join-Path $env:LOCALAPPDATA 'MidenNative846Probe'
if (-not (Test-Path (Join-Path $root 'owned-native-probe-v1.txt'))) { throw 'Owned probe directory missing' }

# Read-only API surface: never switch desktop, send input, or alter a token.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class NativeUiObservation {
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int info, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    public static bool InteractiveUserMatches(uint session, string expected) {
        IntPtr buffer;
        uint bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, 5, out buffer, out bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            return bytes >= 2 && String.Equals(Marshal.PtrToStringUni(buffer), expected, StringComparison.OrdinalIgnoreCase);
        } finally { WTSFreeMemory(buffer); }
    }
    public static string DesktopName(IntPtr handle) {
        if (handle == IntPtr.Zero) throw new InvalidOperationException("Desktop handle unavailable");
        var value = new StringBuilder(256);
        uint needed;
        if (!GetUserObjectInformation(handle, 2, value, 512, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return value.ToString();
    }
}
'@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$self = [Diagnostics.Process]::GetCurrentProcess()
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$interactiveUserMatched = $null
$interactiveUserError = $null
try { $interactiveUserMatched = [NativeUiObservation]::InteractiveUserMatches($self.SessionId, $ExpectedUser) }
catch { $interactiveUserError = $_.Exception.GetType().Name }
$samples = @()
for ($i = 0; $i -lt 3; $i++) {
    $sample = [ordered]@{
        observedAt = [DateTime]::UtcNow.ToString('o')
        processSessionId = $self.SessionId
        elevatedAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        processDesktop = $null
        inputDesktop = $null
        inputDesktopError = $null
        foregroundProcess = $null
        foregroundSessionId = $null
        sameInputDesktop = $false
        controls = @()
        errors = @()
    }
    $inputDesktop = [IntPtr]::Zero
    try {
        $sample.processDesktop = [NativeUiObservation]::DesktopName([NativeUiObservation]::GetThreadDesktop([NativeUiObservation]::GetCurrentThreadId()))
        $inputDesktop = [NativeUiObservation]::OpenInputDesktop(0, $false, 1)
        if ($inputDesktop -eq [IntPtr]::Zero) {
            $sample.inputDesktopError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        } else {
            $sample.inputDesktop = [NativeUiObservation]::DesktopName($inputDesktop)
            $sample.sameInputDesktop = $sample.processDesktop -eq $sample.inputDesktop
        }
        # Do not inspect another desktop, a missing foreground window, or protected UI.
        if ($interactiveUserMatched -eq $true -and $sample.sameInputDesktop -and $sample.inputDesktop -eq 'Default') {
            $window = [NativeUiObservation]::GetForegroundWindow()
            if ($window -ne [IntPtr]::Zero) {
                [uint32]$foregroundId = 0
                [void][NativeUiObservation]::GetWindowThreadProcessId($window, [ref]$foregroundId)
                $foreground = [Diagnostics.Process]::GetProcessById($foregroundId)
                $sample.foregroundProcess = $foreground.ProcessName
                $sample.foregroundSessionId = $foreground.SessionId
                if ($foreground.SessionId -eq $self.SessionId) {
                    $element = [System.Windows.Automation.AutomationElement]::FromHandle($window)
                    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                    for ($j = 0; $j -lt [Math]::Min(12, $children.Count); $j++) {
                        $current = $children.Item($j).Current
                        # Never read control names, text/value patterns, or credential contents.
                        $sample.controls += [ordered]@{
                            controlType = $current.ControlType.ProgrammaticName
                            isPassword = $current.IsPassword
                            enabled = $current.IsEnabled
                            focused = $current.HasKeyboardFocus
                            offscreen = $current.IsOffscreen
                        }
                    }
                }
            }
        }
    } catch {
        $sample.errors += $_.Exception.GetType().Name
    } finally {
        if ($inputDesktop -ne [IntPtr]::Zero) { [void][NativeUiObservation]::CloseDesktop($inputDesktop) }
    }
    $samples += $sample
    if ($i -lt 2) { Start-Sleep -Seconds 5 }
}
$report = [ordered]@{
    schemaVersion = 1
    scope = 'Read-only UI/session observation; no input, wallet or unattended-logon qualification'
    expectedProcessUserMatched = $true
    interactiveUserMatched = $interactiveUserMatched
    interactiveUserError = $interactiveUserError
    samples = $samples
}
$path = Join-Path $root 'native-driver-observation.json'
$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $path -Encoding UTF8
$report | ConvertTo-Json -Depth 7
