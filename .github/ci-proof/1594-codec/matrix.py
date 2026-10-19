#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def git(*args):
    return subprocess.check_output(['git', '-C', str(SOURCE), *args]).decode().strip()


def verify(expected_source, label):
    require(git('rev-parse', 'HEAD') == REQUEST['source_commit'], 'source HEAD drift')
    require(git('rev-parse', 'HEAD^{tree}') == REQUEST['source_tree'], 'source tree drift')
    actual = {}
    for row in REQUEST['files']:
        path = SOURCE / row['path']
        require(path.is_file() and not path.is_symlink(), 'missing/linked input: ' + row['path'])
        digest = sha(path.read_bytes())
        expected = expected_source if row['path'] == TARGET else row['sha256']
        require(digest == expected, 'input drift: ' + row['path'])
        require(bool(path.stat().st_mode & 0o100) == (row['mode'] == '100755'), 'file mode drift')
        actual[row['path']] = digest
    changed = git('diff', '--name-only', 'HEAD').splitlines()
    require(changed == ([] if expected_source == ORIGINAL_HASH else [TARGET]), 'unrelated tracked change')
    require(not git('diff', '--cached', '--name-only'), 'staged source drift')
    require(not git('ls-files', '--others', '--exclude-standard'), 'untracked source input')
    row = {'label': label, 'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
           'source_sha256': expected_source, 'files': actual, 'restored': expected_source == ORIGINAL_HASH}
    CHAIN.append(row)
    save(EVIDENCE / 'hash-chain.json', CHAIN)


def run(command, destination):
    log = destination / 'command.log'
    result = {'command': command, 'cwd': str(MODULE), 'timeout_seconds': 480, 'timed_out': False}
    started = time.monotonic()
    with log.open('wb') as output:
        process = subprocess.Popen(command, cwd=MODULE, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            result['exit'] = process.wait(timeout=480)
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
    result['log_sha256'] = sha(log.read_bytes())
    save(destination / 'command.json', result)
    require(not result['timed_out'] and result['exit'] in (0, 1), 'timeout/signal/setup command exit')
    return result


def junit(destination, expected_names, expect_failure=None):
    report_dir = MODULE / 'build/test-results/testDebugUnitTest'
    paths = sorted(report_dir.glob('TEST-*.xml'))
    require(bool(paths), 'no fresh JUnit XML')
    shutil.copytree(report_dir, destination / 'junit')
    cases = []
    for path in paths:
        suite = ET.parse(path).getroot()
        require(suite.tag == 'testsuite', 'unexpected JUnit root')
        children = suite.findall('testcase')
        require(int(suite.get('tests', '-1')) == len(children), 'JUnit suite/case count mismatch')
        require(int(suite.get('errors', '-1')) == 0 and int(suite.get('skipped', '-1')) == 0, 'JUnit suite error/skip')
        require(int(suite.get('failures', '-1')) == sum(bool(case.findall('failure')) for case in children), 'JUnit failure count mismatch')
        for case in children:
            failures = case.findall('failure')
            require(not case.findall('error') and not case.findall('skipped'), 'JUnit error/skipped case')
            require(len(failures) <= 1, 'multiple failures in a JUnit case')
            failure = failures[0] if failures else None
            cases.append({'class': case.get('classname'), 'name': case.get('name'), 'failure': None if failure is None else {
                'type': failure.get('type', ''), 'message': failure.get('message', ''), 'text': failure.text or ''}})
    names = [case['class'] + '.' + case['name'] for case in cases]
    require(len(names) == len(set(names)) and set(names) == set(expected_names), 'missing/extra/duplicate JUnit case')
    failed = [case for case in cases if case['failure'] is not None]
    save(destination / 'junit-cases.json', cases)
    require(len(failed) == (1 if expect_failure else 0), 'unexpected JUnit failure count')
    if expect_failure:
        failure = failed[0]['failure']
        require(failure['type'] == expect_failure['type'], 'wrong failure exception type')
        for token in expect_failure['message_contains']:
            require(token in failure['message'], 'wrong failure message: ' + token)
        for token in expect_failure['trace_contains']:
            require(token in failure['text'], 'wrong failure origin: ' + token)
    return cases


def tests(destination, method=None, failure=None):
    destination.mkdir()
    shutil.rmtree(MODULE / 'build/test-results/testDebugUnitTest', ignore_errors=True)
    command = GRADLE + ['testDebugUnitTest']
    if method:
        command += ['--tests', method]
    result = run(command, destination)
    cases = junit(destination, [method] if method else REQUEST['junit_cases'], failure)
    require(result['exit'] == (1 if failure else 0), 'wrong JVM command outcome')
    log = (destination / 'command.log').read_text()
    failed_tasks = re.findall(r'^> Task (\S+) FAILED$', log, re.M)
    require(failed_tasks == ([':testDebugUnitTest'] if failure else []), 'unexpected failed Gradle task')
    if failure:
        require("Execution failed for task ':testDebugUnitTest'." in log, 'wrong JVM Gradle failure cause')
    else:
        require('BUILD SUCCESSFUL' in log, 'JVM task did not finish')
    return {'command': result, 'cases': cases}


def lint(destination, arm=None):
    destination.mkdir()
    text_path = MODULE / REQUEST['lint_text_report']
    text_path.unlink(missing_ok=True)
    for path in (MODULE / 'build/reports').glob('lint-results-debug*'):
        if path.is_file():
            path.unlink()
    result = run(GRADLE + ['lintDebug'], destination)
    require(text_path.is_file(), 'no fresh complete lint text report')
    text = text_path.read_text()
    shutil.copyfile(text_path, destination / 'lint-results-debug.txt')
    print(text, flush=True)
    errors = re.findall(r'^(.+?):(\d+): (?:Error|Fatal): (.+) \[([^\]]+)\]$', text, re.M)
    save(destination / 'lint-errors.json', errors)
    if arm:
        require(result['exit'] == 1 and len(errors) == 2, 'wrong API mutant lint outcome')
        require(re.search(r'\b2 errors?, \d+ warnings?\b', text) is not None, 'unexpected lint summary')
        expected_line = TARGET_PATH.read_text().splitlines().index(arm['new_line']) + 1
        observed = set()
        for file, line, message, issue in errors:
            reported = Path(file)
            require((reported if reported.is_absolute() else MODULE / reported).resolve() == TARGET_PATH, 'wrong lint source')
            require(int(line) == expected_line and issue == 'NewApi', 'wrong lint issue/location')
            require('API level 26' in message and 'current min is 24' in message, 'wrong API/minSdk')
            observed.add(message.rsplit(': ', 1)[-1])
        require(observed == set(arm['diagnostics']), 'wrong restored API diagnostics')
        failed_tasks = re.findall(r'^> Task (\S+) FAILED$', (destination / 'command.log').read_text(), re.M)
        require(failed_tasks == [':lintDebug'], 'unexpected failed lint task')
        require("Execution failed for task ':lintDebug'." in (destination / 'command.log').read_text(), 'wrong lint Gradle failure cause')
    else:
        require(result['exit'] == 0 and not errors, 'positive lint control failed')
        require('BUILD SUCCESSFUL' in (destination / 'command.log').read_text(), 'lint task did not finish')
    return {'command': result, 'errors': errors}


def positive(label):
    verify(ORIGINAL_HASH, label + '-before')
    destination = EVIDENCE / label
    destination.mkdir()
    result = {'tests': tests(destination / 'tests'), 'lint': lint(destination / 'lint')}
    verify(ORIGINAL_HASH, label + '-after')
    save(destination / 'accepted.json', result)
    return result


def mutation(arm):
    verify(ORIGINAL_HASH, arm['id'] + '-before')
    destination = EVIDENCE / arm['id']
    destination.mkdir()
    save(destination / 'prediction.json', arm)
    require(ORIGINAL.count(arm['old'].encode()) == 1, 'mutation anchor not unique')
    mutated = ORIGINAL.replace(arm['old'].encode(), arm['new'].encode(), 1)
    require(sha(mutated) == arm['source_sha256'], 'mutation hash mismatch')
    result = None
    try:
        TARGET_PATH.write_bytes(mutated)
        verify(arm['source_sha256'], arm['id'] + '-mutated')
        (destination / 'mutation.patch').write_bytes(subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--binary', '--', TARGET]))
        if arm['kind'] == 'lint':
            result = lint(destination / 'lint', arm)
        else:
            result = tests(destination / 'tests', arm['case'], arm['failure'])
        verify(arm['source_sha256'], arm['id'] + '-after-command')
    finally:
        TARGET_PATH.write_bytes(ORIGINAL)
        verify(ORIGINAL_HASH, arm['id'] + '-restored')
    save(destination / 'accepted.json', result)
    return {'id': arm['id'], 'accepted': True}


def interrupted(signum, frame):
    raise RuntimeError('interrupted by signal ' + str(signum))


require(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI only; local execution prohibited')
SOURCE = Path(sys.argv[1]).resolve()
EVIDENCE = Path(sys.argv[2]).resolve()
REQUEST = json.loads((EVIDENCE / 'request.json').read_text())
TARGET = REQUEST['target']
TARGET_PATH = SOURCE / TARGET
MODULE = SOURCE / 'packages/bread-connect-kotlin'
ORIGINAL_HASH = REQUEST['source_sha256']
ORIGINAL = TARGET_PATH.read_bytes()
require(sha(ORIGINAL) == ORIGINAL_HASH, 'initial source hash mismatch')
GRADLE = ['./gradlew', '--console=plain', '--no-daemon', '--no-build-cache', '--no-configuration-cache', '--rerun-tasks']
CHAIN = []
for signum in (signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupted)
summary = {'source_commit': REQUEST['source_commit'], 'source_tree': REQUEST['source_tree'], 'accepted': False,
           'transport_commit': os.environ.get('GITHUB_SHA'), 'run_id': os.environ.get('GITHUB_RUN_ID'),
           'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'mutations': []}
baseline_ok = False
failure = None
try:
    verify(ORIGINAL_HASH, 'initial')
    summary['fixed_control'] = positive('fixed-control')
    baseline_ok = True
    for arm in REQUEST['mutations']:
        summary['mutations'].append(mutation(arm))
except BaseException:
    failure = traceback.format_exc()
finally:
    try:
        TARGET_PATH.write_bytes(ORIGINAL)
        verify(ORIGINAL_HASH, 'final-restoration')
        if baseline_ok:
            summary['restored_control'] = positive('restored-control')
    except BaseException:
        failure = (failure or '') + '\nRestoration/control failure:\n' + traceback.format_exc()
    summary['accepted'] = failure is None and len(summary['mutations']) == len(REQUEST['mutations']) and 'restored_control' in summary
    summary['failure'] = failure
    save(EVIDENCE / 'matrix-summary.json', summary)
if not summary['accepted']:
    print(failure or 'incomplete proof', file=sys.stderr)
    sys.exit(1)
print('All source-bound F1 proof arms matched their written predictions; feature gates remain separate.')
