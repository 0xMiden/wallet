import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

packet = pathlib.Path(__file__).parent
evidence = pathlib.Path(os.environ['PROOF_EVIDENCE'])
source = json.loads((packet / 'source.json').read_text())
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == source['head']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == source['tree']
for name, expected in source['files'].items():
    assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected
command = [
    'yarn', 'jest', '--runTestsByPath', *source['tests'], '--maxWorkers=2',
    '--testNamePattern=' + source['pattern'], '--json', '--outputFile=' + str(evidence / 'red.json')
]
with (evidence / 'red.log').open('w') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
data = json.loads((evidence / 'red.json').read_text())
executed = [a for suite in data['testResults'] for a in suite['assertionResults'] if a['status'] in ('passed', 'failed')]
failed = [a for a in executed if a['status'] == 'failed']
families = {'telemetry': 0, 'proving': 0, 'queue-race': 0, 'queue-binding': 0}
valid = result.returncode != 0 and len(executed) == 13 and len(failed) == 9 and data['numRuntimeErrorTestSuites'] == 0
for assertion in failed:
    name = assertion['fullName']
    message = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(assertion.get('failureMessages', [])))
    false_true = re.search(r'Expected:\s*false', message) and re.search(r'Received:\s*true', message)
    if 'repairs opted-out telemetry' in name:
        families['telemetry'] += 1
        valid = valid and bool(false_true)
    elif 'unpublished present mirror false and saved choice true' in name:
        families['proving'] += 1
        valid = valid and bool(false_true)
    elif 'captured before cancel and Retry' in name:
        families['queue-race'] += 1
        valid = valid and bool(re.search(r'Received:\s*"in_progress_gate"', message)) and 'toBeUndefined' in message
    elif 'stored label belongs to another incarnation' in name:
        families['queue-binding'] += 1
        valid = valid and '"queueSighting": "never"' in message and 'in_progress_gate' in message
    else:
        valid = False
valid = valid and families == {'telemetry': 5, 'proving': 2, 'queue-race': 1, 'queue-binding': 1}
restored = all(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected for name, expected in source['files'].items())
valid = valid and restored
record = {
    'source': source, 'command': command, 'exit_code': result.returncode,
    'executed': len(executed), 'passed': len(executed) - len(failed), 'failed': len(failed),
    'runtime_errors': data['numRuntimeErrorTestSuites'], 'families': families,
    'assertions': executed, 'source_exact_restored': restored, 'valid': bool(valid)
}
(evidence / 'verified.json').write_text(json.dumps(record, indent=2) + '\n')
print((evidence / 'red.log').read_text(errors='replace'), end='')
print(json.dumps({k: v for k, v in record.items() if k not in ('assertions', 'source', 'command')}))
sys.exit(0 if valid else 91)
