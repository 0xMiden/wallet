import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys

packet = pathlib.Path(__file__).parent
root = pathlib.Path.cwd()
out = root / 'proof'
raw = pathlib.Path(os.environ['RUNNER_TEMP']) / 'aa-review-raw'
raw.mkdir(exist_ok=True)
manifest = json.loads((packet / 'manifest.json').read_text())
results = []


def check_source():
    for rel, expected in manifest['source_file_sha256'].items():
        assert hashlib.sha256((root / rel).read_bytes()).hexdigest() == expected, rel


def command(name, args):
    log = out / (name + '.log')
    with log.open('w') as output:
        run = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'name': name, 'exit': run.returncode}), flush=True)
    if run.returncode:
        print(log.read_text()[-14000:], flush=True)
        raise RuntimeError(name)


def jest(name, files, pattern=None, expected=None):
    result = raw / (name + '.json')
    log = raw / (name + '.log')
    args = ['yarn', 'jest', '--runTestsByPath', *files, '--maxWorkers=2',
            '--json', '--outputFile=' + str(result)]
    if pattern:
        args += ['--testNamePattern', pattern]
    with log.open('w') as output:
        run = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT)
    data = json.loads(result.read_text())
    failed = [a['fullName'] for suite in data['testResults'] for a in suite['assertionResults']
              if a['status'] == 'failed']
    row = {'name': name, 'exit': run.returncode, 'executed': data['numPassedTests'] + data['numFailedTests'],
           'passed': data['numPassedTests'], 'failed': data['numFailedTests'],
           'runtime': data['numRuntimeErrorTestSuites'], 'failed_names': failed}
    results.append(row)
    (out / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(row), flush=True)
    assert row['executed'] > 0 and row['runtime'] == 0, row
    if expected:
        assert run.returncode != 0 and row['executed'] == expected['expected_executed'], row
        assert set(failed) == set(expected['expected_failed_names']), row
        assert row['failed'] == len(expected['expected_failed_names']), row
    else:
        assert run.returncode == 0 and row['failed'] == 0, row
        assert row['executed'] == manifest['expected_baseline_tests'], row


check_source()
command('format', ['yarn', 'prettier', '--check', *manifest['lint_files']])
command('types', ['yarn', 'tsc', '--noEmit'])
command('lint', ['yarn', 'eslint', '--max-warnings=0', *manifest['lint_files']])
jest('baseline', manifest['test_files'])
restored = []
for case in manifest['cases']:
    path = root / case['path']
    before = path.read_bytes()
    source = before.decode()
    assert source.count(case['old']) == case['replacement_count'], case['name']
    try:
        path.write_text(source.replace(case['old'], case['new']))
        jest(case['name'], case['test_files'], case['test_name_pattern'], case)
    finally:
        path.write_bytes(before)
        assert path.read_bytes() == before
        restored.append({'name': case['name'], 'path': case['path'],
                         'sha256': hashlib.sha256(before).hexdigest(), 'restored': True})
        (out / 'restorations.json').write_text(json.dumps(restored, indent=2))
check_source()
assert subprocess.check_output(['git', 'diff', '--name-only'], text=True).strip() == ''
subprocess.run(['git', 'checkout', '--detach', manifest['regression_checkpoint']], check=True)
subprocess.run(['git', 'apply', str(packet / 'fix.patch')], check=True)
check_source()
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
assert changed == manifest['canonical_files'], changed
diff = subprocess.check_output(['git', 'diff', '--unified=0'], text=True)
hunks = []
path = None
for line in diff.splitlines():
    if line.startswith('+++ b/'):
        path = line[6:]
    elif line.startswith('@@'):
        hunks.append({'path': path, 'header': line})
assert len(hunks) == manifest['expected_canonical_hunks'], hunks
canonical = out / 'canonical'
canonical.mkdir()
(canonical / 'hunks.json').write_text(json.dumps(hunks, indent=2))
session = pathlib.Path(os.environ['RUNNER_TEMP']) / 'aa-hunk-session'
session.mkdir()
(session / 'scope.env').write_text('REV_ROOT=' + shlex.quote(str(root)) + '\n')
(session / 'state.json').write_text(json.dumps({'phase': 'fix'}))
test_command = shlex.quote(sys.executable) + ' ' + shlex.quote(str(packet / 'mutation-test.py'))
with (canonical / 'rev-mutate.log').open('w') as output:
    run = subprocess.run(['bash', str(packet / 'rev-mutate.sh'), str(session), test_command],
                         stdout=output, stderr=subprocess.STDOUT)
text = (canonical / 'rev-mutate.log').read_text()
print(text, flush=True)
assert run.returncode == 0, run.returncode
assert text.count('rev-mutate: PINNED ') == len(hunks)
assert 'UNPINNED' not in text and 'UNMEASURED' not in text and 'measured nothing' not in text
attempts = [json.loads((canonical / ('attempt-%d.json' % i)).read_text())
            for i in range(len(hunks) + 2)]
assert json.loads((canonical / 'count.json').read_text()) == len(attempts)
assert all(row['valid_execution'] for row in attempts)
empty = 'Earn page forwards load evidence when the failed Earn tab has no positions'
retained = 'Earn page forwards load evidence when the failed Earn tab retains positions'
rejected = 'useEarnPositions reports complete failure for a rejected refresh with retained partial data'
assert {empty, retained}.issubset(attempts[1]['failed_names'])
assert all('errorDiagnostics is not defined' in message for message in attempts[1]['failure_messages'].values())
for attempt, name in [(attempts[2], empty), (attempts[3], retained), (attempts[4], rejected)]:
    assert attempt['failed_names'] == [name], attempt
    assert 'toEqual' in attempt['failure_messages'][name], attempt
assert 'earnPositionsLoadStage' in attempts[2]['failure_messages'][empty]
assert 'earnPositionsLoadOutcome' in attempts[3]['failure_messages'][retained]
assert 'complete_failure' in attempts[4]['failure_messages'][rejected]
assert 'partial_failure' in attempts[4]['failure_messages'][rejected]
check_source()
subprocess.run(['git', 'restore', '--source=HEAD', '--', *manifest['canonical_files']], check=True)
subprocess.run(['git', 'checkout', '--detach', manifest['source_sha']], check=True)
check_source()
assert subprocess.check_output(['git', 'diff', '--name-only'], text=True).strip() == ''
summary = {'baseline_tests': manifest['expected_baseline_tests'], 'semantic_mutations': len(restored),
           'semantic_intended_failures': sum(row['failed'] for row in results if row['name'] != 'baseline'),
           'canonical_hunks': len(hunks), 'canonical_attempts': len(attempts),
           'canonical_all_valid': True, 'all_source_hashes_restored': True}
assert summary['semantic_intended_failures'] == manifest['expected_semantic_failures']
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary), flush=True)
