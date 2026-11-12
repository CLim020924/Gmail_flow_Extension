param(
    [string] $UrlBase64 = '',
    [string] $OwnerWindowHandle = '',
    [switch] $ProbeOnly
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

[ComImport]
[Guid("3E68D4BD-7135-4D10-8018-9FB6D9F33FA1")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IInitializeWithWindow
{
    void Initialize(IntPtr hwnd);
}

public static class CmoeWindowInitializer
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    public static void Initialize(object target, long hwnd)
    {
        ((IInitializeWithWindow)target).Initialize(new IntPtr(hwnd));
    }

    public static bool IsValidWindow(long hwnd)
    {
        return hwnd > 0 && IsWindow(new IntPtr(hwnd));
    }

    public static bool TryGetCenter(long hwnd, out int x, out int y)
    {
        RECT rect;
        if (!IsValidWindow(hwnd) || !GetWindowRect(new IntPtr(hwnd), out rect))
        {
            x = 0;
            y = 0;
            return false;
        }
        x = rect.Left + ((rect.Right - rect.Left) / 2);
        y = rect.Top + ((rect.Bottom - rect.Top) / 2);
        return true;
    }

    public static long GetForegroundPickerWindow()
    {
        IntPtr hwnd = GetForegroundWindow();
        return IsPickerWindow(hwnd.ToInt64()) ? hwnd.ToInt64() : 0;
    }

    public static bool IsPickerWindow(long hwnd)
    {
        IntPtr handle = new IntPtr(hwnd);
        if (hwnd <= 0 || !IsWindow(handle) || !IsWindowVisible(handle)) return false;
        StringBuilder className = new StringBuilder(128);
        GetClassName(handle, className, className.Capacity);
        return className.ToString().Equals("Open With", StringComparison.Ordinal);
    }

}
'@

[Windows.System.Launcher, Windows.System, ContentType = WindowsRuntime] | Out-Null
[Windows.System.LauncherOptions, Windows.System, ContentType = WindowsRuntime] | Out-Null
$options = [Windows.System.LauncherOptions]::new()
$options.DisplayApplicationPicker = $true

if ($ProbeOnly) {
    exit 0
}

if ([string]::IsNullOrWhiteSpace($UrlBase64)) {
    exit 3
}

$ownerForm = $null
$exitCode = 3

try {
    Add-Type -AssemblyName System.Windows.Forms
    $parsedOwnerHandle = [long] 0
    $hasExternalOwner = [long]::TryParse($OwnerWindowHandle, [ref] $parsedOwnerHandle) -and [CmoeWindowInitializer]::IsValidWindow($parsedOwnerHandle)
    $ownerForm = [Windows.Forms.Form]::new()
    $ownerForm.ShowInTaskbar = $false
    $ownerForm.FormBorderStyle = [Windows.Forms.FormBorderStyle]::None
    $ownerForm.Size = [Drawing.Size]::new(1, 1)
    $ownerForm.Opacity = 0.01
    $ownerForm.TopMost = $true
    if ($hasExternalOwner) {
        $centerX = 0
        $centerY = 0
        if ([CmoeWindowInitializer]::TryGetCenter($parsedOwnerHandle, [ref] $centerX, [ref] $centerY)) {
            $ownerForm.StartPosition = [Windows.Forms.FormStartPosition]::Manual
            $ownerForm.Location = [Drawing.Point]::new($centerX, $centerY)
        } else {
            $ownerForm.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
        }
    } else {
        $ownerForm.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    }
    $ownerForm.Show()
    [Windows.Forms.Application]::DoEvents()
    [CmoeWindowInitializer]::Initialize($options, $ownerForm.Handle.ToInt64())

    $urlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($UrlBase64))
    $uri = [Uri]::new($urlText, [UriKind]::Absolute)
    if ($uri.Scheme -ne 'https') {
        exit 3
    }

    $operation = [Windows.System.Launcher]::LaunchUriAsync($uri, $options)
    $cancelStream = [Console]::OpenStandardInput()
    $cancelBuffer = [byte[]]::new(1)
    $cancelRead = $cancelStream.BeginRead($cancelBuffer, 0, 1, $null, $null)
    $pickerDeadline = [DateTime]::UtcNow.AddMinutes(5)

    # PowerShell 5.1 cannot directly await a projected WinRT operation. The
    # Task bridge drives LaunchUriAsync until Windows has actually presented
    # the chooser, while the message pump keeps its tiny owner responsive.
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethodDefinition -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1
    if ($null -eq $asTaskMethod) {
        throw 'Windows Runtime async bridge is unavailable.'
    }
    $launchTask = $asTaskMethod.MakeGenericMethod([bool]).Invoke($null, @($operation))
    while (-not $launchTask.IsCompleted -and -not $cancelRead.IsCompleted) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 25
    }

    if ($cancelRead.IsCompleted) {
        $exitCode = 2
    } else {
        $opened = [bool] $launchTask.GetAwaiter().GetResult()
        if (-not $opened) {
            $exitCode = 2
        } else {
            $pickerWindow = [long] 0
            $pickerWindowDeadline = [DateTime]::UtcNow.AddSeconds(60)
            while ($pickerWindow -eq 0 -and -not $cancelRead.IsCompleted -and [DateTime]::UtcNow -lt $pickerWindowDeadline) {
                $pickerWindow = [CmoeWindowInitializer]::GetForegroundPickerWindow()
                [Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 25
            }
            if ($env:CMOE_PICKER_DIAGNOSTICS -eq '1') {
                [Console]::Error.WriteLine("OpenWith window: " + $(if ($pickerWindow -eq 0) { 'not found' } else { $pickerWindow }))
            }

            if ($pickerWindow -ne 0) {
                while ([CmoeWindowInitializer]::IsPickerWindow($pickerWindow) -and -not $cancelRead.IsCompleted -and [DateTime]::UtcNow -lt $pickerDeadline) {
                    [Windows.Forms.Application]::DoEvents()
                    Start-Sleep -Milliseconds 25
                }
            }
            $exitCode = if ($cancelRead.IsCompleted) { 2 } else { 0 }
        }
    }
} catch {
    if ($env:CMOE_PICKER_DIAGNOSTICS -eq '1') {
        [Console]::Error.WriteLine($_.Exception.ToString())
    }
    $exitCode = 3
} finally {
    if ($null -ne $ownerForm) {
        $ownerForm.Close()
        $ownerForm.Dispose()
    }
}

exit $exitCode
