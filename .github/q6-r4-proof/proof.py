import hashlib
import json
import os
import pathlib
import subprocess

packet = pathlib.Path(__file__).parent
evidence = pathlib.Path(os.environ['PROOF_EVIDENCE'])
source = json.loads((packet / 'source.json').read_text())
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == source['head']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == source['tree']
for name, expected in source['files'].items():
    assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected
command = ['yarn', 'jest', '--runTestsByPath', *source['tests'], '--maxWorkers=2',
           '--json', '--outputFile=' + str(evidence / 'tests.json')]
with (evidence / 'tests.log').open('w') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
data = json.loads((evidence / 'tests.json').read_text())
counts = {k: data[k] for k in ['numPassedTests', 'numFailedTests', 'numPendingTests',
                              'numRuntimeErrorTestSuites', 'numTotalTests', 'numTotalTestSuites']}
restored = all(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected
               for name, expected in source['files'].items())
valid = (result.returncode == 0 and counts['numPassedTests'] == 365 and counts['numFailedTests'] == 0 and
         counts['numPendingTests'] == 0 and counts['numTotalTests'] == 365 and counts['numTotalTestSuites'] == 7 and
         counts['numRuntimeErrorTestSuites'] == 0 and restored)
(evidence / 'verified.json').write_text(json.dumps(dict(source=source, counts=counts,
    exit_code=result.returncode, source_exact_restored=restored, valid=valid), indent=2) + '\n')
print((evidence / 'tests.log').read_text(errors='replace'), end='')
assert valid
