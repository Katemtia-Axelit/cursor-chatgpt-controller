param(
 [ValidateSet('Verify')][string]$Stage='Verify',
 [int]$Port=41383
)
# Sanitized public reference: verify-only guard. No process restarts or termination.
$ErrorActionPreference='Stop'
$workspace=$env:CONTROLLER_WORKSPACE
$profile=Join-Path $env:APPDATA 'Cursor'
if([string]::IsNullOrWhiteSpace($workspace)){throw 'CONTROLLER_WORKSPACE_REQUIRED'}
if(!(Test-Path -LiteralPath $workspace -PathType Container)){throw 'WORKSPACE_NOT_FOUND'}
if(!(Test-Path -LiteralPath $profile -PathType Container)){throw 'ORIGINAL_CURSOR_PROFILE_NOT_FOUND'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CursorGuardWin32 {
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$name=Split-Path -Path $workspace -Leaf
$windows=@(Get-Process Cursor -ErrorAction SilentlyContinue | Where-Object {
 $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like ('*'+$name+'*')
})
$listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if($windows.Count -ne 1 -or $listeners.Count -ne 1){
 @{ok=$false;code='WAITING_FOR_MAIN_CURSOR_CDP';stage=$Stage;win_count=$windows.Count;listener_count=$listeners.Count}|ConvertTo-Json -Compress
 exit 3
}
$p=$windows[0]
$cmd=(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine
$bound=($listeners[0].OwningProcess -eq $p.Id)
$loopback=($listeners[0].LocalAddress -eq '127.0.0.1')
$original=($null -ne $cmd -and $cmd.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0)
$portOk=($cmd -like ('*--remote-debugging-port='+$Port+'*'))
$settings=Test-Path (Join-Path $profile 'User\settings.json')
$ok=$bound -and $loopback -and $original -and $portOk -and $settings
@{
 ok=$ok;code=if($ok){'ORIGINAL_PRIMARY_CDP_VERIFIED'}else{'PRIMARY_BOUNDARY_MISMATCH'};
 stage=$Stage;pid=$p.Id;process_started_at=$p.StartTime.ToUniversalTime().ToString('o');
 cdp_owner_matches=$bound;loopback_only=$loopback;profile_arg_matches_original=$original;
 original_settings_exists=$settings;
 main_minimized=[CursorGuardWin32]::IsIconic($p.MainWindowHandle);
 main_is_foreground=([CursorGuardWin32]::GetForegroundWindow() -eq $p.MainWindowHandle)
}|ConvertTo-Json -Compress
if(!$ok){exit 6}
