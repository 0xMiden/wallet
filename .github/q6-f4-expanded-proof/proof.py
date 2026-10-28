import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

packet = pathlib.Path(__file__).parent
evidence = pathlib.Path(os.environ['RUNNER_TEMP']) / 'q6-f4-expanded-evidence'
manifest = json.loads((packet / 'source.json').read_text())

def output(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def tree():
    with tempfile.TemporaryDirectory() as directory:
        env = dict(os.environ, GIT_INDEX_FILE=directory + '/index')
        subprocess.run(['git', 'read-tree', 'HEAD'], env=env, check=True)
        subprocess.run(['git', 'add', '-u'], env=env, check=True)
        return subprocess.check_output(['git', 'write-tree'], env=env, text=True).strip()

assert output('rev-parse', 'HEAD') == manifest['source_sha']
assert tree() == manifest['source_tree']
for path, expected in manifest['test_blobs'].items():
    assert output('hash-object', path) == expected, path
assert output('hash-object', 'src/lib/settings/helpers.ts') == manifest['production_helpers_blob']
body = pathlib.Path('src/lib/settings/helpers.capacitor-mirror.test.ts').read_text()
start = body.index("it('keeps a completed telemetry opt-out")
end = body.index("\nit('keeps completed later-key")
assert hashlib.sha256(body[start:end].strip().encode()).hexdigest() == manifest['frozen_native_it_sha256']

result_path = evidence / 'expanded-red.json'
command = ['yarn', 'jest', '--runTestsByPath', *manifest['test_files'], '--maxWorkers=2', '--json', '--outputFile=' + str(result_path)]
with (evidence / 'expanded-red.log').open('w') as stream:
    result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
report = json.loads(result_path.read_text())
counts = manifest['expected_counts']
assert result.returncode == 1
assert report['numTotalTests'] == counts['total']
assert report['numPassedTests'] == counts['passed']
assert report['numFailedTests'] == counts['failed']
assert report['numRuntimeErrorTestSuites'] == counts['runtime']
assert report['numPendingTests'] == 0
assert not report.get('wasInterrupted', False)
assert report['numTotalTestSuites'] == 3
assert report['numFailedTestSuites'] == 2
assert report['numPassedTestSuites'] == 1
assertions = [item for suite in report['testResults'] for item in suite['assertionResults']]
failed = [item for item in assertions if item['status'] == 'failed']
assert {item['fullName'] for item in failed} == set(manifest['expected_failures'])
for item in failed:
    message = re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(item['failureMessages']))
    assert re.search(r'Expected:\s*false', message), item['fullName']
    assert re.search(r'Received:\s*true', message), item['fullName']
    assert item['numPassingAsserts'] >= manifest['expected_failures'][item['fullName']], item['fullName']
    for forbidden in ['ReferenceError', 'TypeError', 'SyntaxError', 'Exceeded timeout', 'Cannot find module']:
        assert forbidden not in message, (item['fullName'], forbidden)
control = [item for item in assertions if item['fullName'] == manifest['recovery_control']]
assert len(control) == 1 and control[0]['status'] == 'passed'
assert tree() == manifest['source_tree']
assert output('rev-parse', 'HEAD') == manifest['source_sha']
verified = {'verified': True, 'purpose': 'expected functional regression failure, not passing product tests', 'source_sha': manifest['source_sha'], 'source_tree': manifest['source_tree'], 'counts': {'total': report['numTotalTests'], 'passed': report['numPassedTests'], 'failed': report['numFailedTests'], 'runtime': report['numRuntimeErrorTestSuites']}, 'exit_code': result.returncode, 'command': command, 'failed_assertions': failed, 'recovery_control': control[0], 'source_restored': True, 'original_native_it_unchanged': True}
(evidence / 'verified.json').write_text(json.dumps(verified, indent=2) + '\n')
print((evidence / 'expanded-red.log').read_text(), flush=True)
print('Expected-red proof verified: 111 executed, 4 intended functional failures, 107 passed, runtime0.', flush=True)
