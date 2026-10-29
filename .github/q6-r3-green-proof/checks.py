import json
import os
import pathlib
import re
import subprocess
import tempfile

PACKET = pathlib.Path(__file__).parent
EVIDENCE = pathlib.Path(os.environ['PROOF_EVIDENCE'])
SOURCE = json.loads((PACKET / 'source.json').read_text())


def tree():
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, GIT_INDEX_FILE=td + '/index')
        subprocess.run(['git', 'read-tree', 'HEAD'], env=env, check=True)
        subprocess.run(['git', 'add', '-u'], env=env, check=True)
        return subprocess.check_output(['git', 'write-tree'], env=env, text=True).strip()


def plain(assertion):
    return re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(assertion.get('failureMessages', [])))


def boolean_failure(assertion, expected=False, received=True):
    text = plain(assertion)
    return bool(re.search(r'Expected:\s*' + str(expected).lower(), text) and
                re.search(r'Received:\s*' + str(received).lower(), text))


def jest(label):
    for name in ['src/lib/settings/helpers.ts', 'src/lib/miden/back/sync-manager.ts',
                 'src/lib/miden/transaction/index.ts']:
        os.utime(name, None)
    command = ['yarn', 'jest', '--runTestsByPath', *SOURCE['tests'], '--maxWorkers=2',
               '--json', '--outputFile=' + str(EVIDENCE / (label + '.json'))]
    with (EVIDENCE / (label + '.log')).open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    data = json.loads((EVIDENCE / (label + '.json')).read_text())
    counts = {k: data[k] for k in ['numPassedTests', 'numFailedTests', 'numPendingTests',
                                  'numRuntimeErrorTestSuites', 'numTotalTests', 'numTotalTestSuites']}
    failures = [a for suite in data['testResults'] for a in suite['assertionResults'] if a['status'] == 'failed']
    valid = (counts['numPassedTests'] + counts['numFailedTests'] == SOURCE['test_count'] and
             counts['numTotalTests'] == SOURCE['test_count'] and counts['numTotalTestSuites'] == 6 and
             counts['numRuntimeErrorTestSuites'] == 0)
    return dict(command=command, exit_code=result.returncode, counts=counts,
                failed_assertions=failures, valid=valid)
