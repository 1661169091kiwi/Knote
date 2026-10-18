param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('electron-ui', 'editor-native', 'dist-win', 'focus', 'cursor-focus', 'interaction-focus', 'table-focus', 'selection-focus', 'overlay-focus', 'resize-focus', 'image-profile', 'packaged-pdf')]
  [string]$Task,
  [Parameter(Mandatory = $true)]
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows only' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLog = [IO.Path]::GetFullPath((Join-Path $taskRoot $LogPath))
if ($taskLog.Contains('"')) { throw 'Invalid log path' }
$taskCommand = switch ($Task) {
  'electron-ui' { 'npm run test:electron-ui' }
  'editor-native' { 'npm run test:editor-native' }
  'dist-win' { 'npm run dist:win' }
  'focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="single-document manual saves|text cursors and native theme" scripts/electron-ui.e2e.test.mjs' }
  'cursor-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="text cursors and native theme|cursor family|custom cursors|table toolbar" scripts/electron-ui.e2e.test.mjs' }
  'interaction-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="native selected text drag" scripts/rich-editor-native.e2e.test.mjs' }
  'table-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="table editing" scripts/rich-editor-native.e2e.test.mjs' }
  'image-profile' { 'node scripts/image-edit-profile.mjs' }
  'overlay-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="block insert|selection toolbar" scripts/rich-editor-native.e2e.test.mjs' }
  'resize-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="sidebar widths drag|readable editor column|resize grips|touch pointer|product tour teaches" scripts/electron-ui.e2e.test.mjs' }
  'selection-focus' { 'node --test --test-concurrency=1 --test-timeout=300000 --test-reporter=tap --test-name-pattern="selection scrolling" scripts/rich-editor-native.e2e.test.mjs' }
  'packaged-pdf' { 'node scripts/packaged-pdf.smoke.mjs' }
}

# Keep real, headed Electron tests on an unselected Windows desktop. No calls
# to SwitchDesktop, taskkill, WMI or process-tree termination are made here.
# Unlike hiding a window, this also contains later show()/focus() calls.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class KnoteBackgroundDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct StartupInfo {
    public uint cb;
    public string reserved, desktop, title;
    public uint x, y, width, height, xChars, yChars, fill, flags;
    public ushort show, reservedBytes;
    public IntPtr reservedData, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

$taskDesktopName = 'KnoteTests-' + [Guid]::NewGuid().ToString('N')
$taskDesktop = [KnoteBackgroundDesktop]::CreateDesktop($taskDesktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($taskDesktop -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
$taskProcess = [KnoteBackgroundDesktop+ProcessInfo]::new()
try {
  $taskStartup = [KnoteBackgroundDesktop+StartupInfo]::new()
  $taskStartup.cb = [Runtime.InteropServices.Marshal]::SizeOf($taskStartup)
  $taskStartup.desktop = 'WinSta0\' + $taskDesktopName
  $taskShell = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
  $taskArgs = [Text.StringBuilder]::new(('"{0}" /d /s /c "{1} > "{2}" 2>&1"' -f $taskShell, $taskCommand, $taskLog))
  if (-not [KnoteBackgroundDesktop]::CreateProcess($taskShell, $taskArgs, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x08000000, [IntPtr]::Zero, $taskRoot, [ref]$taskStartup, [ref]$taskProcess)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  Write-Output "Background task=$Task desktop=$taskDesktopName pid=$($taskProcess.pid) log=$taskLog"
  do {
    $taskWait = [KnoteBackgroundDesktop]::WaitForSingleObject($taskProcess.process, 250)
    if ($taskWait -eq 0xFFFFFFFF) { throw 'Could not wait for background test process' }
  } while ($taskWait -eq 258)
  [uint32]$taskExit = 0
  if (-not [KnoteBackgroundDesktop]::GetExitCodeProcess($taskProcess.process, [ref]$taskExit)) { throw 'Could not read test exit code' }
  Write-Output "Background task exit=$taskExit"
} finally {
  if ($taskProcess.thread -ne [IntPtr]::Zero) { [void][KnoteBackgroundDesktop]::CloseHandle($taskProcess.thread) }
  if ($taskProcess.process -ne [IntPtr]::Zero) { [void][KnoteBackgroundDesktop]::CloseHandle($taskProcess.process) }
  [void][KnoteBackgroundDesktop]::CloseDesktop($taskDesktop)
}
exit $taskExit
