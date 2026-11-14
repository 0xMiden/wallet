$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-protected-observation.ps1'
$source = [IO.File]::ReadAllText($launcher)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher PowerShell syntax failed' }
$children = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('SYSTEM identity required') }, $true))
if ($children.Count -ne 1) { throw 'Expected exactly one constrained child command' }
[void][Management.Automation.Language.Parser]::ParseInput($children[0].Value, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'SYSTEM child command syntax failed' }
foreach ($required in @('Normal approved UAC elevation is required', 'Unexpected staging directory', 'Owned staging marker missing', 'Valid Microsoft signature required', 'Protected copy hash assertion failed', 'Helper service name already in use', 'SetOwner($admins)', 'SetAccessRuleProtection($true, $false)', 'WaitForExit(60000)', '$childProcess.StartTime.ToUniversalTime().ToString(', '$childProcess.SessionId -eq $session', '$childProcess.ProcessName -eq ''powershell''', 'Unowned service appeared; do not alter it', 'Helper image outside the owned expected path', 'if ($failure -or $cleanupErrors.Count)')) {
    if (-not $source.Contains($required)) { throw ('Missing boundary: ' + $required) }
}
foreach ($forbidden in @('Set-ExecutionPolicy', '-ExecutionPolicy', 'Set-MpPreference', 'SetThreadDesktop(', 'SwitchDesktop(', 'SendInput(', 'Get-Credential', "'-p'", "'-u'", 'taskkill', 'Stop-Process -Name')) {
    if ($source.Contains($forbidden)) { throw ('Unexpected capability: ' + $forbidden) }
}
if ($source.IndexOf('Valid Microsoft signature required') -gt $source.IndexOf('Start-Process -FilePath')) { throw 'Signature must be verified before launch' }
$root = Join-Path $env:ProgramData 'MidenNative846ProtectedProbe'
$rootBefore = Test-Path $root
$serviceBefore = [bool](Get-Service -Name 'Miden846ReadOnlyProbe' -ErrorAction SilentlyContinue)
$rejected = $false
try { & $launcher -StagingDirectory 'C:\not-the-approved-owned-stage' }
catch {
    if ($_.Exception.Message -notin @('Normal approved UAC elevation is required', 'Unexpected staging directory')) { throw }
    $rejected = $true
}
if (-not $rejected) { throw 'Invalid context must be rejected' }
if ((Test-Path $root) -ne $rootBefore -or [bool](Get-Service -Name 'Miden846ReadOnlyProbe' -ErrorAction SilentlyContinue) -ne $serviceBefore) { throw 'Rejected context changed machine state' }
'PASS: parent/child parser, static safety boundaries, rejected-context side-effect check. No PsExec or SYSTEM process launched in CI.'
