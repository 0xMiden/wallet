$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MidenNative846Probe'
$launcher = Join-Path $root 'launch-protected-observation.ps1'
$expected = '6041f87b717337b2a8986a1e09c7e9d7dfe6aaab5144c835db689fc2edcd632b'
if (-not (Test-Path (Join-Path $root 'owned-native-probe-v1.txt'))) { throw 'Owned staging marker required before UAC' }
if ((Get-FileHash $launcher).Hash.ToLowerInvariant() -ne $expected) { throw 'Launcher hash mismatch before UAC' }
$command = @'
$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MidenNative846Probe'
$launcher = Join-Path $root 'launch-protected-observation.ps1'
if ((Get-FileHash $launcher).Hash.ToLowerInvariant() -ne '6041f87b717337b2a8986a1e09c7e9d7dfe6aaab5144c835db689fc2edcd632b') { throw 'Launcher hash mismatch after UAC' }
Invoke-Command -ScriptBlock ([ScriptBlock]::Create([IO.File]::ReadAllText($launcher))) -ArgumentList $root
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
# Normal Windows consent; no elevation workaround, policy flag, or credential value.
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $encoded)
