import hashlib
import json
import re
import socket
from pathlib import Path
from unittest.mock import patch

from sentry_relay.processing import convert_datascrubbing_config, pii_strip_event

source = Path('src/lib/telemetry/proposal-create-diagnostics.ts').read_bytes()
assert hashlib.sha256(source).hexdigest() == '5ea07dee3e06ba0fd1e7e60e6ee9d4d5f3bf3745902adf44fbf28a02acca8ef1'
table = source.decode().split('const wireFamilies = {', 1)[1].split('} as const', 1)[0]
pairs = re.findall(r"^\s*(\w+): '([^']+)'", table, re.M)
assert len(pairs) == 13 and len(set(value for _, value in pairs)) == 13
changed = {'consume_note_authentication', 'multisig_auth_args_missing', 'sdk_auth_header_read'}
settings = {'scrubData': True, 'scrubDefaults': True, 'scrubIpAddresses': False, 'excludeFields': [], 'sensitiveFields': []}
def forbid_network(*args, **kwargs):
    raise AssertionError('Synthetic proof must remain offline')
with patch.object(socket, 'socket', forbid_network), patch.object(socket, 'create_connection', forbid_network):
    config = convert_datascrubbing_config(settings)
    for canonical, wire in pairs:
        event = {'contexts': {'walletDiagnostics': {'proposalCreateApi': 'consume_notes', 'proposalCreateFamily': wire}}}
        values = pii_strip_event(config, event)['contexts']['walletDiagnostics']
        assert values == {'proposalCreateApi': 'consume_notes', 'proposalCreateFamily': wire}, (canonical, wire, values)
        if canonical in changed:
            old = {'contexts': {'walletDiagnostics': {'proposalCreateFamily': canonical}}}
            assert pii_strip_event(config, old)['contexts']['walletDiagnostics']['proposalCreateFamily'] == '[Filtered]'
    canaries = {'password': 'synthetic_canary', 'access_token': 'synthetic_canary', 'ordinary': 'synthetic_canary', 'neutral': 'synthetic_auth_marker'}
    result = pii_strip_event(config, {'contexts': {'proof': canaries}})['contexts']['proof']
    assert result['password'] == result['access_token'] == result['neutral'] == '[Filtered]'
    assert result['ordinary'] == 'synthetic_canary'
Path('ct-wire-scrubber-proof.json').write_text(json.dumps({'synthetic_only': True, 'offline': True, 'wire_categories_preserved': len(pairs), 'old_categories_filtered': len(changed), 'privacy_canaries': True, 'source_sha256': hashlib.sha256(source).hexdigest()}, indent=2) + '\n')
print('13 wire categories preserved; 3 old categories filtered; privacy canaries passed')
