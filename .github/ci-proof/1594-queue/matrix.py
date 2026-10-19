#!/usr/bin/env python3
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import traceback


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def git(*args):
    return subprocess.check_output(['git', '-C', str(SOURCE), *args])


def verify(expected_source, label):
    destination = EVIDENCE / 'hash-checks' / label
    destination.mkdir(parents=True)
    (destination / 'whole-tracked.patch').write_bytes(git('diff', '--binary', 'HEAD'))
    (destination / 'staged.patch').write_bytes(git('diff', '--cached', '--binary'))
    state = {'head': git('rev-parse', 'HEAD').decode().strip(), 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'changed': git('diff', '--name-only', 'HEAD').decode().splitlines(),
             'untracked': git('ls-files', '--others', '--exclude-standard').decode().splitlines(), 'files': {}}
    for row in REQUEST['files']:
        path = SOURCE / row['path']
        require(path.is_file() and not path.is_symlink(), 'missing/linked input: ' + row['path'])
        state['files'][row['path']] = {'sha256': sha(path.read_bytes()), 'executable': bool(path.stat().st_mode & 0o100)}
    save(destination / 'observed.json', state)
    CHAIN.append({'label': label, 'observed_sha256': sha((destination / 'observed.json').read_bytes()),
                  'whole_tracked_patch_sha256': sha((destination / 'whole-tracked.patch').read_bytes())})
    save(EVIDENCE / 'hash-chain.json', CHAIN)
    require(state['head'] == REQUEST['source_commit'] and state['tree'] == REQUEST['source_tree'], 'source identity drift')
    require(state['changed'] == ([] if expected_source == ORIGINAL_HASH else [TARGET]), 'unrelated tracked drift')
    require(not (destination / 'staged.patch').read_bytes() and not state['untracked'], 'staged/untracked source drift')
    for row in REQUEST['files']:
        observed = state['files'][row['path']]
        expected = expected_source if row['path'] == TARGET else row['sha256']
        require(observed['sha256'] == expected and observed['executable'] == (row['mode'] == '100755'), 'input drift: ' + row['path'])
    if INVENTORY is not None:
        require(sha((EVIDENCE / 'runtime-inventory.json').read_bytes()) == INVENTORY_HASH, 'runtime inventory drift')


def run(command, destination, timeout):
    destination.mkdir()
    result = {'command': command, 'timeout_seconds': timeout, 'timed_out': False, 'cwd': str(SOURCE)}
    started = time.monotonic()
    with (destination / 'command.log').open('wb') as log:
        process = subprocess.Popen(command, cwd=SOURCE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                   env={**os.environ, 'CI': 'true', 'FORCE_COLOR': '0', 'NO_COLOR': '1'})
        try:
            result['exit'] = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            result['timed_out'] = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            result['exit'] = process.returncode
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    result['log_sha256'] = sha((destination / 'command.log').read_bytes())
    save(destination / 'command.json', result)
    require(not result['timed_out'] and result['exit'] in (0, 1), 'timeout/signal/setup exit')
    return result


def identity(case):
    ancestors = case.get('ancestorTitles')
    require(isinstance(ancestors, list) and all(isinstance(value, str) for value in ancestors), 'invalid case class')
    require(isinstance(case.get('title'), str) and isinstance(case.get('fullName'), str), 'invalid case name')
    require(case['fullName'] == ' '.join([*ancestors, case['title']]), 'case class/name mismatch')
    return {'ancestors': ancestors, 'title': case['title'], 'fullName': case['fullName']}


def inventory(cases):
    return sorted([identity(case) for case in cases], key=lambda item: json.dumps(item, sort_keys=True))


def counter(rows):
    return Counter(json.dumps(row, sort_keys=True) for row in rows)


def failure_cause(case, arm, destination):
    require(case['ancestorTitles'] == ['actions', 'processDApp'], 'wrong failed case class')
    require(case['fullName'] == arm['failed_case'], 'wrong failed case')
    messages = case.get('failureMessages')
    require(isinstance(messages, list) and len(messages) == 1, 'unexpected assertion/runtime failure count')
    message = re.sub(r'\x1b\[[0-9;]*m', '', messages[0])
    (destination / 'observed-failure.txt').write_text(message)
    require(re.search(r'actions\.test\.ts:' + str(arm['assertion_line']) + r':\d+', message) is not None, 'wrong failure line')
    require(arm['matcher_text'] in message, 'wrong assertion matcher')
    for pattern in arm['failure_patterns']:
        require(re.search(pattern, message, re.M | re.S) is not None, 'wrong assertion cause: ' + pattern)
    if arm['id'] == 'omit-login-sign-session':
        expected = re.search(r'Expected:\s*(.*?)\n\s*Received:', message, re.S)
        received = re.search(r'Received:\s*(.*?)\n\s*Number of calls:', message, re.S)
        require(expected is not None and received is not None, 'missing argument comparison')
        require('session-7' in expected.group(1) and 'session-7' not in received.group(1), 'wrong session argument failure')
        for token in ['https://example.com', 'LOGIN_SIGN_REQUEST']:
            require(token in expected.group(1) and token in received.group(1), 'wrong unchanged request argument')


def jest(destination, arm=None):
    output = destination / 'jest-results.json'
    require(not output.exists(), 'stale Jest JSON')
    command = ['node', 'node_modules/jest/bin/jest.js', '--runTestsByPath', TEST, '--maxWorkers=2', '--no-cache', '--json',
               '--outputFile=' + str(output)]
    if arm:
        command += ['--testNamePattern=' + REQUEST['target_pattern']]
    result = run(command, destination, 300)
    require(output.is_file(), 'missing Jest JSON; setup/compiler failure gives no credit')
    document = json.loads(output.read_text())
    require(document.get('wasInterrupted') is False and document.get('numRuntimeErrorTestSuites') == 0, 'runtime/interrupted suite')
    require(document.get('numTotalTestSuites') == 1 and document.get('numPendingTestSuites') == 0, 'wrong/skipped test suite')
    suites = document.get('testResults')
    require(isinstance(suites, list) and len(suites) == 1, 'missing/extra suite')
    suite = suites[0]
    require(Path(suite['name']).resolve() == (SOURCE / TEST).resolve() and suite.get('testExecError') is None, 'wrong suite/setup error')
    cases = suite.get('assertionResults')
    require(isinstance(cases, list) and len(cases) >= 2, 'missing runtime test cases')
    observed = inventory(cases)
    require(all(case.get('status') in ('passed', 'failed', 'pending') for case in cases), 'unknown/todo/disabled test status')
    for status, field in [('passed', 'numPassedTests'), ('failed', 'numFailedTests'), ('pending', 'numPendingTests')]:
        require(document.get(field) == sum(case['status'] == status for case in cases), 'Jest count mismatch: ' + field)
    require(document.get('numTotalTests') == len(cases) and document.get('numTodoTests') == 0, 'Jest total/todo mismatch')
    for name in REQUEST['target_cases']:
        require(sum(case['fullName'] == name for case in cases) == 1, 'target case missing/duplicated')
    failed = [case for case in cases if case['status'] == 'failed']
    pending = [case for case in cases if case['status'] == 'pending']
    for case in cases:
        if case['status'] != 'failed':
            require(not case.get('failureMessages'), 'unexpected nonfailed case error')
    if arm:
        require(INVENTORY is not None and counter(observed) <= counter(INVENTORY), 'unexpected mutant runtime case')
        targets = [case for case in cases if case['fullName'] in REQUEST['target_cases']]
        require(len(targets) == 2 and all(case['status'] in ('passed', 'failed') for case in targets), 'target skip/pending')
        require(len(failed) == 1 and sum(case['status'] == 'passed' for case in cases) == 1, 'wrong targeted failure/pass count')
        require(all(case['fullName'] not in REQUEST['target_cases'] for case in pending), 'target excluded')
        require(len(pending) == len(cases) - 2, 'non-target execution')
        failure_cause(failed[0], arm, destination)
        expected_success = False
    else:
        require(not failed and not pending and all(case['status'] == 'passed' for case in cases), 'full control failed/skipped')
        if INVENTORY is not None:
            require(observed == INVENTORY, 'restored runtime inventory mismatch')
        expected_success = True
    require(document.get('success') is expected_success and result['exit'] == (0 if expected_success else 1), 'wrong Jest process/result outcome')
    require(document.get('numFailedTestSuites') == (0 if expected_success else 1), 'wrong failed suite count')
    require(document.get('numPassedTestSuites') == (1 if expected_success else 0), 'wrong passed suite count')
    require(suite.get('status') == ('passed' if expected_success else 'failed'), 'wrong suite status')
    excluded = [row for row in INVENTORY if row['fullName'] not in REQUEST['target_cases']] if arm else []
    report = {'command': result, 'jest_json_sha256': sha(output.read_bytes()), 'observed_inventory': observed, 'failed': failed,
              'reported_pending_not_covered': [identity(case) for case in pending],
              'intentionally_excluded_not_covered': excluded, 'runtime_inventory_sha256': INVENTORY_HASH}
    save(destination / 'accepted.json', report)
    return observed


def positive(label):
    verify(ORIGINAL_HASH, label + '-before')
    observed = jest(EVIDENCE / label)
    verify(ORIGINAL_HASH, label + '-after')
    return observed


def mutate(arm):
    verify(ORIGINAL_HASH, arm['id'] + '-before')
    destination = EVIDENCE / arm['id']
    destination.mkdir()
    save(destination / 'prediction.json', arm)
    require(ORIGINAL.count(arm['old'].encode()) == 1, 'nonunique mutation anchor')
    changed = ORIGINAL.replace(arm['old'].encode(), arm['new'].encode(), 1)
    require(sha(changed) == arm['source_sha256'], 'mutation hash mismatch')
    try:
        TARGET_PATH.write_bytes(changed)
        verify(arm['source_sha256'], arm['id'] + '-mutated')
        (destination / 'mutation.patch').write_bytes(git('diff', '--binary', 'HEAD'))
        jest(destination / 'tests', arm)
        verify(arm['source_sha256'], arm['id'] + '-after-command')
    finally:
        TARGET_PATH.write_bytes(ORIGINAL)
        verify(ORIGINAL_HASH, arm['id'] + '-restored')
    return {'id': arm['id'], 'accepted': True}


def interrupted(signum, frame):
    raise RuntimeError('interrupted by signal ' + str(signum))


require(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI only; local execution prohibited')
SOURCE = Path(sys.argv[1]).resolve()
EVIDENCE = Path(sys.argv[2]).resolve()
REQUEST = json.loads((EVIDENCE / 'request.json').read_text())
TARGET = REQUEST['target']
TEST = REQUEST['test']
TARGET_PATH = SOURCE / TARGET
ORIGINAL_HASH = REQUEST['source_sha256']
ORIGINAL = TARGET_PATH.read_bytes()
require(sha(ORIGINAL) == ORIGINAL_HASH, 'initial source hash mismatch')
CHAIN = []
INVENTORY = None
INVENTORY_HASH = None
for signum in (signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupted)
summary = {'source_commit': REQUEST['source_commit'], 'source_tree': REQUEST['source_tree'], 'accepted': False,
           'transport_commit': os.environ.get('GITHUB_SHA'), 'run_id': os.environ.get('GITHUB_RUN_ID'),
           'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'mutations': []}
failure = None
try:
    verify(ORIGINAL_HASH, 'before-install')
    node = subprocess.check_output(['node', '--version']).decode().strip()
    require(node.startswith('v22.'), 'Node22 required')
    summary['node_version'] = node
    summary['install'] = run(['yarn', 'install', '--frozen-lockfile', '--network-timeout', '600000'], EVIDENCE / 'install', 480)
    require(summary['install']['exit'] == 0, 'frozen install failed')
    verify(ORIGINAL_HASH, 'after-install')
    INVENTORY = positive('fixed-control')
    save(EVIDENCE / 'runtime-inventory.json', {'source_commit': REQUEST['source_commit'], 'source_tree': REQUEST['source_tree'],
         'observed_from': 'fixed-control/jest-results.json', 'jest_json_sha256': sha((EVIDENCE / 'fixed-control/jest-results.json').read_bytes()),
         'cases': INVENTORY})
    INVENTORY_HASH = sha((EVIDENCE / 'runtime-inventory.json').read_bytes())
    summary['runtime_inventory_sha256'] = INVENTORY_HASH
    summary['observed_full_test_count'] = len(INVENTORY)
    for arm in REQUEST['mutations']:
        summary['mutations'].append(mutate(arm))
except BaseException:
    failure = traceback.format_exc()
finally:
    try:
        TARGET_PATH.write_bytes(ORIGINAL)
        verify(ORIGINAL_HASH, 'final-restoration')
        if INVENTORY is not None:
            positive('restored-control')
            summary['restored_control'] = True
    except BaseException:
        failure = (failure or '') + '\nRestoration/control failure:\n' + traceback.format_exc()
    summary['accepted'] = failure is None and len(summary['mutations']) == 3 and summary.get('restored_control') is True
    summary['failure'] = failure
    save(EVIDENCE / 'matrix-summary.json', summary)
if not summary['accepted']:
    print(failure or 'incomplete proof', file=sys.stderr)
    sys.exit(1)
print('Queue/session proof matched its predictions; feature gates and final review remain separate.')
