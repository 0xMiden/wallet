from pathlib import Path
import json
import subprocess

out = Path('mutation-proof')
out.mkdir(exist_ok=True)
mutations = [
    ('codec_wire', 'src/offscreen/main.ts',
     'errorTransactionExecution: snapshotTransactionExecution(err),', '', 1,
     'src/offscreen/main.test.ts', 'carries .* through every actual diagnostic boundary', 'executionRoute'),
    ('sign_lock_wire', 'src/lib/miden/guardian/index.ts',
     "return withProposalStep('sign_lock', () =>", 'return (', 1,
     'src/lib/miden/transaction/proposal-diagnostics.integration.test.ts',
     'post-create sign_lock reaches actual cancellation', 'sign_lock')
]
for name, filename, old, new, count, test, pattern, required in mutations:
    path = Path(filename)
    original = path.read_text()
    assert original.count(old) == count, (name, 'mutation selector changed')
    path.write_text(original.replace(old, new))
    try:
        result = subprocess.run(['yarn', 'jest', '--runInBand', test, '--testNamePattern=' + pattern,
                                 '--json', '--outputFile=' + str(out / (name + '.json'))],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        (out / (name + '.log')).write_text(result.stdout)
        print(result.stdout[-5000:])
        data = json.loads((out / (name + '.json')).read_text())
        failures = [item for suite in data['testResults'] for item in suite.get('assertionResults', [])
                    if item['status'] == 'failed']
        assert result.returncode != 0 and data['numFailedTests'] > 0
        assert data.get('numRuntimeErrorTestSuites', 0) == 0 and failures
        assert all(required in '\n'.join(item.get('failureMessages', [])) for item in failures)
        print(name, 'expected wire assertion failures:', data['numFailedTests'], 'executed:',
              data['numPassedTests'] + data['numFailedTests'])
    finally:
        path.write_text(original)
