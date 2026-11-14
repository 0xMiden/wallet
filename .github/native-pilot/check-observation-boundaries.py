"""Static policy checks only: not PowerShell syntax, runtime, or native qualification."""
from pathlib import Path
import hashlib
import json

path = Path(__file__).with_name('observe-ui-session.ps1')
source = path.read_text()
assert source.index('Unexpected Windows user') < source.index('Add-Type')
assert source.index('Owned probe directory missing') < source.index('Add-Type')
assert 'OpenInputDesktop(0, $false, 1)' in source
assert 'CloseDesktop($inputDesktop)' in source
assert 'finally { WTSFreeMemory(buffer); }' in source
assert "$interactiveUserMatched -eq $true -and $sample.sameInputDesktop -and $sample.inputDesktop -eq 'Default'" in source
for forbidden in ('SendInput(', 'SwitchDesktop(', 'SetThreadDesktop(', 'CreateProcessAsUser(', 'Register-ScheduledTask', 'GetCurrentPattern', '.Current.Name', 'ValuePattern', 'Set-ItemProperty', 'Get-Credential'):
    assert forbidden not in source, forbidden
properties = {line.split('$current.', 1)[1].strip() for line in source.splitlines() if '= $current.' in line}
assert properties == {'ControlType.ProgrammaticName', 'IsPassword', 'IsEnabled', 'HasKeyboardFocus', 'IsOffscreen'}
receipt = {
    'scope': 'Unexecuted read-only guest observation source',
    'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    'bytes': path.stat().st_size,
    'checks': 'Static boundary checks only; PowerShell syntax/runtime and guest execution NOT RUN',
    'credentialValues': 'none',
    'clipboardAuthority': 'Prior one-time approval consumed; no replacement performed',
}
path.with_name('observation-source-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
