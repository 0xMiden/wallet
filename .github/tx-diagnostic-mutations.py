from pathlib import Path
import json
import subprocess

out = Path('mutation-proof')
out.mkdir(exist_ok=True)
mutations = [
    ('observer', 'src/lib/miden/sdk/miden-client-interface.ts',
     "execution = observeTransactionExecutionRequest(request, 'ordinary_new_transaction');",
     "execution = unobservedTransactionExecution('ordinary_new_transaction');", 2,
     'src/lib/miden/sdk/miden-client-interface.prove-worker.test.ts', 'observes .* on the actual request'),
    ('codec', 'src/offscreen/main.ts',
     'errorTransactionExecution: snapshotTransactionExecution(err),', '', 1,
     'src/offscreen/main.test.ts', 'guardianPipeline sends only closed observations'),
    ('proposal', 'src/lib/miden/guardian/index.ts',
     "this.proposalStep('proposal_sign', () => this.multisig.signProposal(id))",
     "withGuardianAuthFacts(this.authFacts, () => this.multisig.signProposal(id))", 1,
     'src/lib/miden/transaction/proposal-diagnostics.integration.test.ts',
     'post-create proposal_sign reaches actual cancellation')
]
for name, filename, old, new, count, test, pattern in mutations:
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
        assert all('expect(' in '\n'.join(item.get('failureMessages', [])) for item in failures)
        print(name, 'expected functional failures:', data['numFailedTests'], 'executed:',
              data['numPassedTests'] + data['numFailedTests'])
    finally:
        path.write_text(original)
