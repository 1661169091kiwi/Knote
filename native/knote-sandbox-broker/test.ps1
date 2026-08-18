[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:BrokerPath = Join-Path $PSScriptRoot 'bin\KnoteSandboxBroker.exe'
$script:ProbePath = Join-Path $PSScriptRoot 'bin\KnoteSandboxProbe.exe'

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Write-TestFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function New-TaskManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TaskId,
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Argv,
        [Parameter(Mandatory = $true)]
        [string]$Cwd,
        [Parameter(Mandatory = $true)]
        [string]$StagingRoot,
        [int]$TimeoutMs = 10000,
        [long]$MemoryBytes = 536870912,
        [int]$ProcessCount = 1,
        [int]$StdoutBytes = 65536
    )

    return [ordered]@{
        manifestVersion = 'knote.sandbox-task.v1'
        taskId = $TaskId
        executable = $Executable
        argv = @($Argv)
        cwd = $Cwd
        stagingRoot = $StagingRoot
        timeoutMs = $TimeoutMs
        memoryBytes = $MemoryBytes
        processCount = $ProcessCount
        stdoutBytes = $StdoutBytes
    }
}

function Invoke-BrokerManifest {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Manifest
    )

    $json = ConvertTo-Json -InputObject $Manifest -Depth 8 -Compress
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:BrokerPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $inputBytes = $script:Utf8NoBom.GetBytes($json)
        $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
        $process.StandardInput.Close()
        $process.WaitForExit()
        $raw = $stdoutTask.GetAwaiter().GetResult()
        $nativeError = $stderrTask.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }

    if ([String]::IsNullOrWhiteSpace($raw)) {
        throw "Broker returned no JSON (exit $exitCode): $nativeError"
    }

    try {
        $result = ConvertFrom-Json -InputObject $raw
    }
    catch {
        throw "Broker returned invalid JSON (exit $exitCode): $raw"
    }

    return [PSCustomObject]@{
        ExitCode = $exitCode
        Result = $result
        Raw = $raw
    }
}

function Assert-IsolationAttestation {
    param(
        [Parameter(Mandatory = $true)]
        [PSObject]$Result
    )

    $evidence = $Result | ConvertTo-Json -Compress -Depth 8
    Assert-True ([bool]$Result.isolationEnforced) "isolationEnforced must be true. Evidence: $evidence"
    Assert-True ([bool]$Result.tokenIsAppContainer) "TokenIsAppContainer must be true. Evidence: $evidence"
    Assert-True ([bool]$Result.appContainerSidVerified) "The child AppContainer SID must match the unique profile SID. Evidence: $evidence"
    Assert-True (-not [String]::IsNullOrWhiteSpace([string]$Result.appContainerSid)) "AppContainer SID must be present. Evidence: $evidence"
    Assert-True ([bool]$Result.jobAssigned) "The child must be assigned to the configured Job. Evidence: $evidence"
    Assert-True ([string]$Result.jobAssignment -eq 'creation_attribute') "The Job must be assigned atomically during process creation. Evidence: $evidence"
    Assert-True ([bool]$Result.jobLimitsVerified) "The configured Job limits must verify by query. Evidence: $evidence"
    Assert-True (-not [bool]$Result.breakawayAllowed) "Job breakaway must not be allowed. Evidence: $evidence"
    Assert-True ([bool]$Result.stagingAcl) "The staging ACL must verify. Evidence: $evidence"
    Assert-True ([bool]$Result.runtimeAclReadExecute) "The runtime ACL must be read/execute without write. Evidence: $evidence"
    Assert-True ([bool]$Result.stagingHandlesPinned) "Every existing staging object must be handle-pinned. Evidence: $evidence"
    Assert-True ([bool]$Result.executableIdentityVerified) "The executable identity must be revalidated before launch. Evidence: $evidence"
    Assert-True ([string]$Result.networkCapabilities -eq 'none') "The token must have no capabilities. Evidence: $evidence"
    Assert-True ([int]$Result.capabilityCount -eq 0) "Token capability count must be zero. Evidence: $evidence"
    Assert-True (-not [bool]$Result.loopbackExempt) "The unique profile must not have a loopback exemption. Evidence: $evidence"
}

function Assert-BrokerPolicyRejected {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Manifest,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $run = Invoke-BrokerManifest -Manifest $Manifest
    Assert-True ($run.ExitCode -ne 0) "$Label must return a nonzero broker exit code."
    Assert-True (-not [bool]$run.Result.isolationEnforced) "$Label must not attest isolationEnforced."
    Assert-True ([string]$run.Result.error.code -eq $ExpectedCode) "$Label returned unexpected evidence: $($run.Raw)"
}

function New-LoopbackListener {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $accept = $listener.BeginAcceptTcpClient($null, $null)
    return [PSCustomObject]@{
        Listener = $listener
        Accept = $accept
        Port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
}

function Stop-LoopbackListener {
    param(
        [Parameter(Mandatory = $true)]
        [PSObject]$State
    )

    $connected = $State.Accept.IsCompleted
    if ($connected) {
        try {
            $client = $State.Listener.EndAcceptTcpClient($State.Accept)
            $client.Close()
        }
        catch {
        }
    }
    $State.Listener.Stop()
    return $connected
}

function Assert-ProcessGone {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessIdValue,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    Start-Sleep -Milliseconds 400
    $process = Get-Process -Id $ProcessIdValue -ErrorAction SilentlyContinue
    Assert-True ($null -eq $process) "$Label PID $ProcessIdValue survived Job closure."
}

function Invoke-ProbeFallback {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunRoot,
        [Parameter(Mandatory = $true)]
        [string]$SentinelPath,
        [AllowNull()]
        [string]$CompatibilityMessage
    )

    $staging = Join-Path $RunRoot 'probe-staging'
    $runtime = Join-Path $staging 'runtime'
    $work = Join-Path $staging 'work'
    $null = New-Item -ItemType Directory -Path $runtime
    $null = New-Item -ItemType Directory -Path $work
    $probeExecutable = Join-Path $runtime 'KnoteSandboxProbe.exe'
    Copy-Item -LiteralPath $script:ProbePath -Destination $probeExecutable
    Write-TestFile -Path (Join-Path $work 'probe-input.txt') -Content 'probe-input'

    $listenerState = New-LoopbackListener
    try {
        $manifest = New-TaskManifest `
            -TaskId 'probe-fallback' `
            -Executable $probeExecutable `
            -Argv @('--staging', $staging, '--host-sentinel', $SentinelPath, '--loopback-port', [string]$listenerState.Port) `
            -Cwd $work `
            -StagingRoot $staging `
            -TimeoutMs 10000 `
            -MemoryBytes 268435456 `
            -ProcessCount 1 `
            -StdoutBytes 65536
        $run = Invoke-BrokerManifest -Manifest $manifest
    }
    finally {
        $loopbackConnected = Stop-LoopbackListener -State $listenerState
    }

    if ($run.Result.termination -ne 'EXITED' -or [long]$run.Result.exitCode -ne 0) {
        if ([String]::IsNullOrWhiteSpace($CompatibilityMessage)) {
            throw "C# probe validation failed: $($run.Raw)"
        }
        throw "Node compatibility failure was '$CompatibilityMessage', and the C# probe also failed: $($run.Raw)"
    }

    Assert-IsolationAttestation -Result $run.Result
    $probe = ConvertFrom-Json -InputObject ([string]$run.Result.stdout).Trim()
    Assert-True ([bool]$probe.isolationObserved) "Probe did not observe complete isolation: $($run.Result.stdout)"
    Assert-True ([bool]$probe.tokenIsAppContainer) 'Probe TokenIsAppContainer must be true.'
    Assert-True ([string]$probe.appContainerSid -eq [string]$run.Result.appContainerSid) 'Probe and broker AppContainer SIDs must match.'
    Assert-True ([bool]$probe.jobAssigned) 'Probe must observe Job membership.'
    Assert-True ([bool]$probe.stagingRead) 'Probe must read staging.'
    Assert-True ([bool]$probe.stagingWrite) 'Probe must write staging.'
    Assert-True ([bool]$probe.hostSentinelDenied) 'Probe must not read the host sentinel.'
    Assert-True ([bool]$probe.loopbackDenied) 'Probe loopback connect must fail.'
    Assert-True ([bool]$probe.publicNetworkDenied) 'Probe public network connect must fail.'
    Assert-True (-not $loopbackConnected) 'The host listener observed a probe loopback connection.'
    Assert-True (Test-Path -LiteralPath (Join-Path $work 'probe-output.txt') -PathType Leaf) 'Probe staging output is missing.'

    if ([String]::IsNullOrWhiteSpace($CompatibilityMessage)) {
        Write-Host 'PASS: C# probe independently verified AppContainer token/SID, staging ACL, host denial, network denial, and Job membership.'
    }
    else {
        Write-Host "DIAGNOSTIC_ONLY_NODE_COMPATIBILITY_FAILURE: $CompatibilityMessage"
        Write-Host 'The C# probe verified base AppContainer mechanics, but it cannot satisfy the Node runtime compatibility gate.'
    }
}

$parentDirectory = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $parentDirectory -PathType Container)) {
    throw "Parent directory does not exist: $parentDirectory"
}

& (Join-Path $PSScriptRoot 'build.ps1') | Out-Null
if (-not (Test-Path -LiteralPath $script:BrokerPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $script:ProbePath -PathType Leaf)) {
    throw 'build.ps1 did not produce the broker and probe executables.'
}

$nodeSource = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf)) {
    throw "Signed Node runtime not found: $nodeSource"
}
$nodeSignature = Get-AuthenticodeSignature -LiteralPath $nodeSource
if ($nodeSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Node Authenticode signature is not valid: $($nodeSignature.Status)"
}

$testRunsParent = Join-Path $PSScriptRoot '.test-runs'
if (-not (Test-Path -LiteralPath $PSScriptRoot -PathType Container)) {
    throw "Test parent directory does not exist: $PSScriptRoot"
}
if (-not (Test-Path -LiteralPath $testRunsParent -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $testRunsParent
}

$runRoot = Join-Path $testRunsParent ([Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $runRoot

try {
    $sentinelPath = Join-Path $runRoot 'host-sentinel.txt'
    Write-TestFile -Path $sentinelPath -Content 'HOST-SECRET-SENTINEL'

    $hardlinkStaging = Join-Path $runRoot 'hardlink-staging'
    $hardlinkRuntime = Join-Path $hardlinkStaging 'runtime'
    $hardlinkWork = Join-Path $hardlinkStaging 'work'
    $null = New-Item -ItemType Directory -Path $hardlinkRuntime
    $null = New-Item -ItemType Directory -Path $hardlinkWork
    $hardlinkExecutable = Join-Path $hardlinkRuntime 'KnoteSandboxProbe.exe'
    Copy-Item -LiteralPath $script:ProbePath -Destination $hardlinkExecutable
    $hardlinkInput = Join-Path $hardlinkWork 'input.txt'
    Write-TestFile -Path $hardlinkInput -Content 'hardlink-input'
    $null = New-Item -ItemType HardLink -Path (Join-Path $hardlinkWork 'input-alias.txt') -Target $hardlinkInput
    $hardlinkManifest = New-TaskManifest `
        -TaskId 'reject-hardlinked-input' `
        -Executable $hardlinkExecutable `
        -Argv @('--not-launched') `
        -Cwd $hardlinkWork `
        -StagingRoot $hardlinkStaging
    Assert-BrokerPolicyRejected -Manifest $hardlinkManifest -ExpectedCode 'HARDLINK_REJECTED' -Label 'Hard-linked staging input'
    Write-Host 'PASS: hard-linked staging input was rejected by handle identity validation.'

    $junctionTarget = Join-Path $runRoot 'junction-target'
    $junctionStaging = Join-Path $runRoot 'junction-staging'
    $junctionRuntime = Join-Path $junctionStaging 'runtime'
    $junctionWork = Join-Path $junctionStaging 'work'
    $null = New-Item -ItemType Directory -Path $junctionTarget
    $null = New-Item -ItemType Directory -Path $junctionRuntime
    $null = New-Item -ItemType Directory -Path $junctionWork
    $junctionExecutable = Join-Path $junctionRuntime 'KnoteSandboxProbe.exe'
    Copy-Item -LiteralPath $script:ProbePath -Destination $junctionExecutable
    $junctionCreated = $false
    try {
        $null = New-Item -ItemType Junction -Path (Join-Path $junctionWork 'outside-junction') -Target $junctionTarget
        $junctionCreated = $true
    }
    catch {
        Write-Host "SKIP: junction rejection test could not create a junction: $($_.Exception.Message)"
    }
    if ($junctionCreated) {
        $junctionManifest = New-TaskManifest `
            -TaskId 'reject-junction' `
            -Executable $junctionExecutable `
            -Argv @('--not-launched') `
            -Cwd $junctionWork `
            -StagingRoot $junctionStaging
        Assert-BrokerPolicyRejected -Manifest $junctionManifest -ExpectedCode 'REPARSE_POINT_REJECTED' -Label 'Staging junction'
        Write-Host 'PASS: staging junction was rejected from handle attributes and reparse tag.'
    }

    $staging = Join-Path $runRoot 'node-staging'
    $runtime = Join-Path $staging 'runtime'
    $work = Join-Path $staging 'work'
    $null = New-Item -ItemType Directory -Path $runtime
    $null = New-Item -ItemType Directory -Path $work
    $nodeExecutable = Join-Path $runtime 'node.exe'
    Copy-Item -LiteralPath $nodeSource -Destination $nodeExecutable

    $normalScript = @'
const fs = require('fs');
const path = require('path');
(async () => {
  console.log('normal-js-started');
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(process.cwd(), 'normal-output.txt'), 'await-ok');
  console.log('await-setTimeout-ok');
})().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exitCode = 10;
});
'@
    Write-TestFile -Path (Join-Path $work 'normal.js') -Content $normalScript

    $securityScript = @'
const fs = require('fs');
const path = require('path');

async function fetchDenied(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    await response.arrayBuffer();
    return false;
  } catch (_) {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const sentinel = process.argv[2];
  const port = Number(process.argv[3]);
  let hostReadDenied = false;
  let hostReadError = null;
  try {
    fs.readFileSync(sentinel, 'utf8');
  } catch (error) {
    hostReadDenied = true;
    hostReadError = error.code || error.name;
  }

  fs.writeFileSync(path.join(process.cwd(), 'staging-write.txt'), 'staging-write-ok');
  const loopbackDenied = await fetchDenied(`http://127.0.0.1:${port}/`);
  const publicDenied = await fetchDenied('http://1.1.1.1/');
  const result = { hostReadDenied, hostReadError, stagingWrite: true, loopbackDenied, publicDenied };
  console.log(JSON.stringify(result));
  if (!hostReadDenied || !loopbackDenied || !publicDenied) process.exitCode = 20;
})().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exitCode = 21;
});
'@
    Write-TestFile -Path (Join-Path $work 'security.js') -Content $securityScript

    $forkChildScript = @'
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'fork-escaped.txt'), String(process.pid));
if (process.send) process.send({ started: true });
setInterval(() => {}, 1000);
'@
    Write-TestFile -Path (Join-Path $work 'fork-child.js') -Content $forkChildScript

    $forkParentScript = @'
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const marker = path.join(process.cwd(), 'fork-escaped.txt');
fs.writeFileSync(path.join(process.cwd(), 'fork-attempted.txt'), String(process.pid));
let finished = false;
function finish(blocked, detail) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ forkBlocked: blocked, detail }));
  process.exit(blocked ? 0 : 30);
}
try {
  const child = fork(path.join(process.cwd(), 'fork-child.js'), [], { silent: true });
  child.once('error', (error) => finish(true, error.code || error.message));
  child.once('exit', (code, signal) => finish(!fs.existsSync(marker), `exit:${code}:${signal}`));
  child.once('message', () => finish(false, 'child-ran'));
  setTimeout(() => finish(!fs.existsSync(marker), 'deadline'), 1200);
} catch (error) {
  finish(true, error.code || error.message);
}
'@
    Write-TestFile -Path (Join-Path $work 'fork-parent.js') -Content $forkParentScript

    $spawnLimitChildScript = @'
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'spawn-limit-escaped.txt'), String(process.pid));
setInterval(() => {}, 1000);
'@
    Write-TestFile -Path (Join-Path $work 'spawn-limit-child.js') -Content $spawnLimitChildScript

    $spawnLimitParentScript = @'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const marker = path.join(process.cwd(), 'spawn-limit-escaped.txt');
fs.writeFileSync(path.join(process.cwd(), 'spawn-limit-attempted.txt'), String(process.pid));
let finished = false;
function finish(blocked, detail) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ childBlocked: blocked, detail }));
  process.exit(blocked ? 0 : 31);
}
try {
  const child = spawn(process.execPath, [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    path.join(process.cwd(), 'spawn-limit-child.js')
  ], { stdio: 'ignore', windowsHide: true });
  child.once('error', (error) => finish(true, error.code || error.message));
  child.once('exit', (code, signal) => finish(!fs.existsSync(marker), `exit:${code}:${signal}`));
  setTimeout(() => finish(!fs.existsSync(marker), 'deadline'), 1200);
} catch (error) {
  finish(true, error.code || error.message);
}
'@
    Write-TestFile -Path (Join-Path $work 'spawn-limit-parent.js') -Content $spawnLimitParentScript

    $timeoutChildScript = @'
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'timeout-child.pid'), String(process.pid));
setInterval(() => {}, 1000);
'@
    Write-TestFile -Path (Join-Path $work 'timeout-child.js') -Content $timeoutChildScript

    $timeoutRootScript = @'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
fs.writeFileSync(path.join(process.cwd(), 'timeout-root.pid'), String(process.pid));
const child = spawn(process.execPath, [
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  path.join(process.cwd(), 'timeout-child.js')
], { stdio: 'ignore', windowsHide: true });
child.once('error', (error) => {
  fs.writeFileSync(path.join(process.cwd(), 'timeout-spawn.error'), error.code || error.message);
});
setInterval(() => {}, 1000);
'@
    Write-TestFile -Path (Join-Path $work 'timeout-root.js') -Content $timeoutRootScript

    $outputScript = @'
for (let index = 0; index < 128; index++) {
  process.stdout.write('x'.repeat(4096));
}
'@
    Write-TestFile -Path (Join-Path $work 'output-limit.js') -Content $outputScript

    $normalManifest = New-TaskManifest `
        -TaskId 'node-normal-await' `
        -Executable $nodeExecutable `
        -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'normal.js')) `
        -Cwd $work `
        -StagingRoot $staging
    $normalRun = Invoke-BrokerManifest -Manifest $normalManifest

    if ($normalRun.Result.termination -eq 'LAUNCH_FAILED') {
        $compatibility = "$($normalRun.Result.error.code) at $($normalRun.Result.error.stage), nativeError=$($normalRun.Result.error.nativeError): $($normalRun.Result.error.message)"
        Invoke-ProbeFallback -RunRoot $runRoot -SentinelPath $sentinelPath -CompatibilityMessage $compatibility
        throw "Node AppContainer runtime compatibility gate failed after diagnostic probe passed: $compatibility"
    }

    Assert-IsolationAttestation -Result $normalRun.Result
    Assert-True ($normalRun.ExitCode -eq 0) "Normal Node broker exit was $($normalRun.ExitCode): $($normalRun.Raw)"
    Assert-True ([string]$normalRun.Result.termination -eq 'EXITED') 'Normal Node task did not exit normally.'
    Assert-True ([long]$normalRun.Result.exitCode -eq 0) "Normal Node task failed: $($normalRun.Result.stderr)"
    Assert-True ([string]$normalRun.Result.stdout -match 'normal-js-started') 'Normal JS marker is absent.'
    Assert-True ([string]$normalRun.Result.stdout -match 'await-setTimeout-ok') 'await setTimeout marker is absent.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $work 'normal-output.txt') -Raw).Trim() -eq 'await-ok') 'Normal staging output is incorrect.'

    $listenerState = New-LoopbackListener
    try {
        $securityManifest = New-TaskManifest `
            -TaskId 'node-filesystem-network' `
            -Executable $nodeExecutable `
            -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'security.js'), $sentinelPath, [string]$listenerState.Port) `
            -Cwd $work `
            -StagingRoot $staging
        $securityRun = Invoke-BrokerManifest -Manifest $securityManifest
    }
    finally {
        $loopbackConnected = Stop-LoopbackListener -State $listenerState
    }

    Assert-IsolationAttestation -Result $securityRun.Result
    Assert-True ([string]$securityRun.Result.termination -eq 'EXITED' -and [long]$securityRun.Result.exitCode -eq 0) "Filesystem/network task failed: $($securityRun.Raw)"
    $securityResult = ConvertFrom-Json -InputObject ([string]$securityRun.Result.stdout).Trim()
    Assert-True ([bool]$securityResult.hostReadDenied) 'Node read the host sentinel outside staging.'
    Assert-True ([bool]$securityResult.stagingWrite) 'Node could not write staging.'
    Assert-True ([bool]$securityResult.loopbackDenied) 'Node fetch reached loopback.'
    Assert-True ([bool]$securityResult.publicDenied) 'Node fetch reached the public network.'
    Assert-True (-not $loopbackConnected) 'The host listener observed a Node loopback connection.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $work 'staging-write.txt') -Raw).Trim() -eq 'staging-write-ok') 'Node staging write is incorrect.'

    $forkManifest = New-TaskManifest `
        -TaskId 'node-process-limit' `
        -Executable $nodeExecutable `
        -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'fork-parent.js')) `
        -Cwd $work `
        -StagingRoot $staging `
        -TimeoutMs 3000 `
        -ProcessCount 1
    $forkRun = Invoke-BrokerManifest -Manifest $forkManifest
    Assert-IsolationAttestation -Result $forkRun.Result
    Assert-True (Test-Path -LiteralPath (Join-Path $work 'fork-attempted.txt') -PathType Leaf) 'Node did not reach the fork attempt.'
    if ([string]$forkRun.Result.termination -eq 'EXITED') {
        Assert-True ([long]$forkRun.Result.exitCode -eq 0) "processCount did not constrain fork: $($forkRun.Raw)"
        $forkResult = ConvertFrom-Json -InputObject ([string]$forkRun.Result.stdout).Trim()
        Assert-True ([bool]$forkResult.forkBlocked) 'Node fork escaped active-process limit 1.'
    }
    elseif ([string]$forkRun.Result.termination -ne 'TIMEOUT') {
        throw "Unexpected fork constraint result: $($forkRun.Raw)"
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $work 'fork-escaped.txt'))) 'Fork child wrote its escape marker.'

    $spawnLimitManifest = New-TaskManifest `
        -TaskId 'node-spawn-process-limit' `
        -Executable $nodeExecutable `
        -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'spawn-limit-parent.js')) `
        -Cwd $work `
        -StagingRoot $staging `
        -TimeoutMs 3000 `
        -ProcessCount 1
    $spawnLimitRun = Invoke-BrokerManifest -Manifest $spawnLimitManifest
    Assert-IsolationAttestation -Result $spawnLimitRun.Result
    Assert-True (Test-Path -LiteralPath (Join-Path $work 'spawn-limit-attempted.txt') -PathType Leaf) 'Node did not reach the spawn attempt.'
    if ([string]$spawnLimitRun.Result.termination -eq 'EXITED') {
        Assert-True ([long]$spawnLimitRun.Result.exitCode -eq 0) "processCount did not constrain spawn: $($spawnLimitRun.Raw)"
        $spawnLimitResult = ConvertFrom-Json -InputObject ([string]$spawnLimitRun.Result.stdout).Trim()
        Assert-True ([bool]$spawnLimitResult.childBlocked) 'Node spawn escaped active-process limit 1.'
    }
    elseif ([string]$spawnLimitRun.Result.termination -ne 'TIMEOUT') {
        throw "Unexpected spawn constraint result: $($spawnLimitRun.Raw)"
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $work 'spawn-limit-escaped.txt'))) 'Spawn child escaped active-process limit 1.'

    $timeoutManifest = New-TaskManifest `
        -TaskId 'node-timeout-descendants' `
        -Executable $nodeExecutable `
        -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'timeout-root.js')) `
        -Cwd $work `
        -StagingRoot $staging `
        -TimeoutMs 3500 `
        -ProcessCount 2
    $timeoutRun = Invoke-BrokerManifest -Manifest $timeoutManifest
    Assert-IsolationAttestation -Result $timeoutRun.Result
    Assert-True ([string]$timeoutRun.Result.termination -eq 'TIMEOUT') "Expected TIMEOUT: $($timeoutRun.Raw)"
    $rootPidPath = Join-Path $work 'timeout-root.pid'
    $childPidPath = Join-Path $work 'timeout-child.pid'
    Assert-True (Test-Path -LiteralPath $rootPidPath -PathType Leaf) 'Timeout root PID file is missing.'
    Assert-True (Test-Path -LiteralPath $childPidPath -PathType Leaf) 'Timeout child PID file is missing; descendant Job coverage was not exercised.'
    $rootProcessId = [int](Get-Content -LiteralPath $rootPidPath -Raw).Trim()
    $childProcessId = [int](Get-Content -LiteralPath $childPidPath -Raw).Trim()
    Assert-ProcessGone -ProcessIdValue $rootProcessId -Label 'Root'
    Assert-ProcessGone -ProcessIdValue $childProcessId -Label 'Descendant'

    $outputManifest = New-TaskManifest `
        -TaskId 'node-output-limit' `
        -Executable $nodeExecutable `
        -Argv @('--preserve-symlinks', '--preserve-symlinks-main', (Join-Path $work 'output-limit.js')) `
        -Cwd $work `
        -StagingRoot $staging `
        -StdoutBytes 1024
    $outputRun = Invoke-BrokerManifest -Manifest $outputManifest
    Assert-IsolationAttestation -Result $outputRun.Result
    Assert-True ([string]$outputRun.Result.termination -eq 'OUTPUT_LIMIT') "Expected OUTPUT_LIMIT, not truncated success: $($outputRun.Raw)"
    Assert-True ($outputRun.ExitCode -ne 0) 'OUTPUT_LIMIT must return a nonzero broker exit code.'
    Assert-True (([long]$outputRun.Result.stdoutCapturedBytes + [long]$outputRun.Result.stderrCapturedBytes) -le 1024) 'Captured output exceeded stdoutBytes.'

    Invoke-ProbeFallback -RunRoot $runRoot -SentinelPath $sentinelPath

    Write-Host 'PASS: signed Node ran in a verified AppContainer with staging-only ACL, zero network capabilities/loopback exemption, and Job limits.'
    Write-Host 'PASS: normal JS + await, host read denial, staging write, fetch denial, fork/spawn constraints, timeout descendant cleanup, and OUTPUT_LIMIT verified.'
}
finally {
    if (Test-Path -LiteralPath $runRoot) {
        Remove-Item -LiteralPath $runRoot -Recurse -Force
    }
}
