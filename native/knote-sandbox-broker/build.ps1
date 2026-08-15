[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$parentDirectory = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $parentDirectory -PathType Container)) {
    throw "Parent directory does not exist: $parentDirectory"
}

$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "Required x64 C# compiler does not exist: $compiler"
}

$webExtensions = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'
if (-not (Test-Path -LiteralPath $webExtensions -PathType Leaf)) {
    throw "Required framework assembly does not exist: $webExtensions"
}

$nativeSource = Join-Path $PSScriptRoot 'NativeMethods.cs'
$brokerSource = Join-Path $PSScriptRoot 'KnoteSandboxBroker.cs'
$probeSource = Join-Path $PSScriptRoot 'KnoteSandboxProbe.cs'
foreach ($source in @($nativeSource, $brokerSource, $probeSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Source file does not exist: $source"
    }
}

$binDirectory = Join-Path $PSScriptRoot 'bin'
if (-not (Test-Path -LiteralPath $binDirectory -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $binDirectory
}

$brokerOutput = Join-Path $binDirectory 'KnoteSandboxBroker.exe'
$probeOutput = Join-Path $binDirectory 'KnoteSandboxProbe.exe'
$commonArguments = @(
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    '/checked+',
    '/utf8output',
    "/reference:$webExtensions"
)

& $compiler @commonArguments "/out:$brokerOutput" $nativeSource $brokerSource
if ($LASTEXITCODE -ne 0) {
    throw "Broker compilation failed with exit code $LASTEXITCODE."
}

& $compiler @commonArguments "/out:$probeOutput" $nativeSource $probeSource
if ($LASTEXITCODE -ne 0) {
    throw "Probe compilation failed with exit code $LASTEXITCODE."
}

Get-Item -LiteralPath $brokerOutput, $probeOutput |
    Select-Object FullName, Length, LastWriteTime
