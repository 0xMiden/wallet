import json
import re
import subprocess
import sys

from checks import EVIDENCE, PACKET, SOURCE, boolean_failure, jest, plain, tree

record = EVIDENCE / 'runs.json'
runs = json.loads(record.read_text()) if record.exists() else []
n = len(runs)
assert n <= SOURCE['hunks'] + 1
row = None if n in (0, SOURCE['hunks'] + 1) else json.loads((PACKET / 'mutation-trees.json').read_text())[n - 1]
label = 'baseline' if n == 0 else 'closing' if row is None else 'mutation-' + str(n)
observed = tree()
assert observed == (SOURCE['tree'] if row is None else row['source_tree'])
if row is not None and row['kind'] == 'structural':
    command = ['yarn', 'tsc', '--noEmit']
    with (EVIDENCE / (label + '.log')).open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    message = (EVIDENCE / (label + '.log')).read_text(errors='replace')
    valid = result.returncode != 0 and bool(re.search(r'error TS\d+', message)) and row['prediction'] in message
    data = dict(command=command, exit_code=result.returncode, counts=None, failed_assertions=[],
                tests_executed=0, validation='STRUCTURAL typecheck only; no Jest or functional claim', valid=valid)
else:
    data = jest(label)
    if row is None:
        data['valid'] = data['valid'] and data['exit_code'] == 0 and data['counts']['numPassedTests'] == 325
    else:
        matches = [a for a in data['failed_assertions'] if row['prediction'] in a['fullName']]
        data['valid'] = data['valid'] and data['exit_code'] != 0 and bool(matches)
        if n in (3, 9, 10, 11, 13):
            data['valid'] = data['valid'] and any(boolean_failure(a) for a in matches)
        elif n == 12:
            data['valid'] = data['valid'] and any(boolean_failure(a, True, False) for a in matches)
        elif n == 5:
            data['valid'] = data['valid'] and any('"queueSighting": "never"' in plain(a) for a in matches)
        elif n == 6:
            data['valid'] = data['valid'] and any('toBeUndefined' in plain(a) and
                                                 'Received: "in_progress_gate"' in plain(a) for a in matches)
        joined = '\n'.join(plain(a) for a in data['failed_assertions'])
        data['valid'] = data['valid'] and 'ReferenceError' not in joined and 'TypeError' not in joined
    data['validation'] = 'Jest functional assertions' if row is not None else 'Jest green gate'
data.update(label=label, source_tree=observed, mutation=row)
runs.append(data)
record.write_text(json.dumps(runs, indent=2) + '\n')
print((EVIDENCE / (label + '.log')).read_text(errors='replace'), end='')
if not data['valid']:
    print('INVALID PROOF: ' + label, file=sys.stderr)
    sys.exit(91)
sys.exit(data['exit_code'])
