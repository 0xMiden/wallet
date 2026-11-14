param([Parameter(Mandatory = $true)][string]$StagingDirectory)
$ErrorActionPreference = 'Stop'
$observerHash = 'b668b8670a0f46a58f540ec3c9eb0a5c7fcfbbf39b05428a642590b8a4d29b4c'
$toolHash = '8f63a763f6d71fa88bf0cceefe647ab5724836db9b9402f8ecdb0d21741a5bfd'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Normal approved UAC elevation is required' }
$expectedStage = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MidenNative846Probe'
if ([IO.Path]::GetFullPath($StagingDirectory) -ine $expectedStage) { throw 'Unexpected staging directory' }
if (-not (Test-Path (Join-Path $StagingDirectory 'owned-native-probe-v1.txt'))) { throw 'Owned staging marker missing' }
$source = Join-Path $StagingDirectory 'observe-ui-session.ps1'
$tool = Join-Path $StagingDirectory 'PsExec64.exe'
if ((Get-FileHash $source).Hash.ToLowerInvariant() -ne $observerHash) { throw 'Observer source hash mismatch' }
if ((Get-FileHash $tool).Hash.ToLowerInvariant() -ne $toolHash) { throw 'Microsoft helper hash mismatch' }
$signature = Get-AuthenticodeSignature $tool
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') { throw 'Valid Microsoft signature required' }
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($session -le 0) { throw 'Interactive session required' }
$serviceName = 'Miden846ReadOnlyProbe'
$root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'MidenNative846ProtectedProbe'
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'Helper service name already in use; do not alter it' }
if (Test-Path $root) { throw 'Protected probe directory already exists; do not alter it' }
$created = $false
$process = $null
$cleanupErrors = @()
$report = $null
$failure = $null
$serviceImage = $null
$diagnostics = @()
$startedHelper = $false
try {
    [void](New-Item -ItemType Directory -Path $root)
    $created = $true
    $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($admins, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($root, $acl)
    $actualAcl = Get-Acl $root
    if (-not $actualAcl.AreAccessRulesProtected -or $actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $admins.Value) { throw 'Protected directory ownership/ACL assertion failed' }
    foreach ($rule in $actualAcl.Access) {
        if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($admins.Value, $system.Value)) { throw 'Unexpected protected-directory principal' }
    }
    $observer = Join-Path $root 'observer.ps1'
    $protectedTool = Join-Path $root 'PsExec64.exe'
    Copy-Item -LiteralPath $source -Destination $observer
    Copy-Item -LiteralPath $tool -Destination $protectedTool
    if ((Get-FileHash $observer).Hash.ToLowerInvariant() -ne $observerHash -or (Get-FileHash $protectedTool).Hash.ToLowerInvariant() -ne $toolHash) { throw 'Protected copy hash assertion failed' }
    $data = Join-Path $root 'MidenNative846Probe'
    [void](New-Item -ItemType Directory -Path $data)
    'Owned temporary read-only SYSTEM measurement' | Set-Content (Join-Path $data 'owned-native-probe-v1.txt')
    $child = @'
$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'SYSTEM identity required' }
$root = 'ROOT_PATH'
$self = [Diagnostics.Process]::GetCurrentProcess()
@{ id = $self.Id; started = $self.StartTime.ToUniversalTime().ToString('o'); session = $self.SessionId; systemIdentityVerified = $true } | ConvertTo-Json | Set-Content (Join-Path $root 'child-owned.json')
$source = Join-Path $root 'observer.ps1'
if ((Get-FileHash $source).Hash.ToLowerInvariant() -ne 'OBSERVER_HASH') { throw 'SYSTEM source hash mismatch' }
$env:LOCALAPPDATA = $root
Invoke-Command -ScriptBlock ([ScriptBlock]::Create([IO.File]::ReadAllText($source))) -ArgumentList ([Environment]::UserName)
'@
    $child = $child.Replace('ROOT_PATH', $root.Replace("'", "''")).Replace('OBSERVER_HASH', $observerHash)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
    $arguments = @('-accepteula', '-nobanner', '-r', $serviceName, '-s', '-i', [string]$session, '-x', (Join-Path $PSHOME 'powershell.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
    $process = Start-Process -FilePath $protectedTool -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $root 'helper.stdout') -RedirectStandardError (Join-Path $root 'helper.stderr')
    $startedHelper = $true
    # The elevated parent remains separate from the measured child and enforces its deadline.
    for ($i = 0; $i -lt 10 -and -not $process.HasExited; $i++) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
        if ($service) { $serviceImage = $service.PathName; break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $process.WaitForExit(60000)) { throw 'Read-only helper exceeded 60-second deadline' }
    if ($process.ExitCode -ne 0) { throw ('Microsoft helper returned exit ' + $process.ExitCode) }
    $owner = Get-Content (Join-Path $root 'child-owned.json') -Raw | ConvertFrom-Json
    if (-not $owner.systemIdentityVerified -or $owner.session -ne $session) { throw 'SYSTEM child identity/session assertion failed' }
    $report = Get-Content (Join-Path $data 'native-driver-observation.json') -Raw | ConvertFrom-Json
    if ($report.samples.Count -ne 3 -or -not $report.expectedProcessUserMatched) { throw 'SYSTEM observer report assertion failed' }
} catch {
    $failure = $_.Exception.Message
} finally {
    if ($created) {
        try {
            if ($process -and -not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
            $ownerPath = Join-Path $root 'child-owned.json'
            if (Test-Path $ownerPath) {
                $owner = Get-Content $ownerPath -Raw | ConvertFrom-Json
                $childProcess = Get-Process -Id $owner.id -ErrorAction SilentlyContinue
                if ($childProcess -and $childProcess.StartTime.ToUniversalTime().ToString('o') -eq $owner.started -and $childProcess.SessionId -eq $session -and $childProcess.ProcessName -eq 'powershell') { $childProcess.Kill(); [void]$childProcess.WaitForExit(5000) }
            }
        } catch { $cleanupErrors += 'Owned process cleanup failed' }
        try {
            $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
            if ($service -and -not $startedHelper) { throw 'Unowned service appeared; do not alter it' }
            if ($service) {
                if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force }
                $null = sc.exe delete $serviceName
                if ($LASTEXITCODE -ne 0) { throw 'Owned service deletion failed' }
                Start-Sleep -Milliseconds 500
            }
            if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'Owned service remains' }
            if ($serviceImage) {
                $image = [Environment]::ExpandEnvironmentVariables($serviceImage.Trim('"'))
                $expectedImage = Join-Path ([Environment]::GetFolderPath('Windows')) ($serviceName + '.exe')
                if ([IO.Path]::GetFullPath($image) -ieq $expectedImage -and (Test-Path $image)) {
                    $imageSignature = Get-AuthenticodeSignature $image
                    if ($imageSignature.Status -ne 'Valid' -or $imageSignature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') { throw 'Owned service binary signature mismatch' }
                    Remove-Item -LiteralPath $image
                } elseif (Test-Path $image) { throw 'Helper image outside the owned expected path; retained for inspection' }
            }
        } catch { $cleanupErrors += 'Owned service/binary cleanup failed' }
        $stderr = Join-Path $root 'helper.stderr'
        if (Test-Path $stderr) { $diagnostics = @(Get-Content -LiteralPath $stderr -Tail 8 -ErrorAction SilentlyContinue) }
        if (-not $cleanupErrors.Count) {
            try { Remove-Item -LiteralPath $root -Recurse -Force }
            catch { $cleanupErrors += 'Protected directory cleanup failed' }
        }
    }
}
$summary = [ordered]@{
    scope = 'Approved temporary SYSTEM read-only desktop access measurement; NOT credential input or wallet qualification'
    sessionId = $session
    helperSignature = 'Valid Microsoft Corporation'
    helperSha256 = $toolHash
    observerSha256 = $observerHash
    failure = $failure
    helperDiagnostics = $diagnostics
    sampleCount = $(if ($report) { $report.samples.Count } else { 0 })
    processDesktops = @($report.samples | ForEach-Object { $_.processDesktop } | Select-Object -Unique)
    inputDesktops = @($report.samples | ForEach-Object { $_.inputDesktop } | Select-Object -Unique)
    inputDesktopErrors = @($report.samples | ForEach-Object { $_.inputDesktopError } | Select-Object -Unique)
    sampleErrors = @($report.samples | ForEach-Object { $_.errors })
    cleanupErrors = $cleanupErrors
    serviceAbsent = -not [bool](Get-Service -Name $serviceName -ErrorAction SilentlyContinue)
    protectedDirectoryAbsent = -not (Test-Path $root)
}
$summary | ConvertTo-Json -Depth 5
if ($failure -or $cleanupErrors.Count) { throw 'Protected-desktop probe failed or cleanup needs attention; inspect the summary, do not retry blindly' }
