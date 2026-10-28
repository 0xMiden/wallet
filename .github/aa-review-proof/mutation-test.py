import json
import os
import pathlib
import re
import subprocess
import sys

packet = pathlib.Path(__file__).parent
root = pathlib.Path.cwd()
proof = root / 'proof' / 'canonical'
raw = pathlib.Path(os.environ['RUNNER_TEMP']) / 'aa-review-raw'
manifest = json.loads((packet / 'manifest.json').read_text())
counter = proof / 'count.json'
index = json.loads(counter.read_text()) if counter.exists() else 0
counter.write_text(json.dumps(index + 1))
result = raw / ('canonical-%d.json' % index)
log = raw / ('canonical-%d.log' % index)
args = ['yarn', 'jest', '--runTestsByPath', 'src/app/pages/Earn.test.tsx',
        'src/screens/earn-flow/useEarnPositions.test.ts', '--maxWorkers=2',
        '--json', '--outputFile=' + str(result)]
with log.open('w') as output:
    run = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT)
data = json.loads(result.read_text())
failures = [a for suite in data['testResults'] for a in suite['assertionResults'] if a['status'] == 'failed']
messages = {a['fullName']: re.sub(r'\x1b\[[0-9;]*m', '', '\n'.join(a['failureMessages']))[:2400]
            for a in failures}
green = index in [0, manifest['expected_canonical_hunks'] + 1]
valid = (data['numPassedTests'] + data['numFailedTests'] == manifest['expected_canonical_tests']
         and data['numRuntimeErrorTestSuites'] == 0
         and ((run.returncode == 0 and data['numFailedTests'] == 0) if green
              else (run.returncode != 0 and data['numFailedTests'] > 0)))
row = {'index': index, 'exit': run.returncode, 'executed': data['numPassedTests'] + data['numFailedTests'],
       'passed': data['numPassedTests'], 'failed': data['numFailedTests'],
       'runtime': data['numRuntimeErrorTestSuites'], 'valid_execution': valid,
       'expected_green': green, 'failed_names': list(messages), 'failure_messages': messages}
(proof / ('attempt-%d.json' % index)).write_text(json.dumps(row, indent=2))
print(json.dumps({k: v for k, v in row.items() if k != 'failure_messages'}), flush=True)
if messages:
    print(next(iter(messages.values())), flush=True)
sys.exit(run.returncode if valid else 2)
