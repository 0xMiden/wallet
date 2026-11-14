$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MidenNative846Probe'
$launcher = Join-Path $root 'launch-protected-observation.ps1'
$expected = 'e89cb40233c085462108e91ff4432176b9502344b5fafc4ad86bf94530c97a75'
if (-not (Test-Path (Join-Path $root 'owned-native-probe-v1.txt'))) { throw 'Owned staging marker required before UAC' }
if ((Get-FileHash $launcher).Hash.ToLowerInvariant() -ne $expected) { throw 'Launcher hash mismatch before UAC' }
$command = @'
$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MidenNative846Probe'
$launcher = Join-Path $root 'launch-protected-observation.ps1'
if ((Get-FileHash $launcher).Hash.ToLowerInvariant() -ne 'e89cb40233c085462108e91ff4432176b9502344b5fafc4ad86bf94530c97a75') { throw 'Launcher hash mismatch after UAC' }
Invoke-Command -ScriptBlock ([ScriptBlock]::Create([IO.File]::ReadAllText($launcher))) -ArgumentList $root
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
# Normal Windows consent; no elevation workaround, policy flag, or credential value.
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $encoded)
