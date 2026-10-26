#!/usr/bin/env python3
"""Run bounded recovery mutation checks only in the pinned disposable CI checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def execute(command, log_path, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('Mutation budget exhausted')
    with log_path.open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('CI disposable checkout required; no local mutation execution')
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes)
    if git('rev-parse', 'HEAD') != manifest['source']:
        raise SystemExit('Source revision mismatch')
    root = Path(git('rev-parse', '--show-toplevel')).resolve()
    if Path.cwd().resolve() != root:
        raise SystemExit('Run from the disposable checkout root')
    args.output.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + manifest['total_budget_seconds']
    summary = {'source': manifest['source'], 'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(), 'mutants': []}
    for mutant in manifest['mutants']:
        path = root / mutant['path']
        expected = subprocess.check_output(['git', 'show', manifest['source'] + ':' + mutant['path']])
        if path.read_bytes() != expected:
            raise SystemExit('Source file changed: ' + mutant['path'])
        before = mutant['before'].encode()
        if expected.count(before) != 1 or mutant['before'] == mutant['after']:
            raise SystemExit('Mutation is not unique: ' + mutant['id'])
        if not 1 <= len(mutant['suites']) <= 2:
            raise SystemExit('Invalid suite bound')
        result_path = (args.output / (mutant['id'] + '.json')).resolve()
        log_path = args.output / (mutant['id'] + '.log')
        command = ['yarn', 'jest', '--runTestsByPath', *mutant['suites'], '--testNamePattern=' + mutant['pattern'],
                   '--maxWorkers=2', '--json', '--outputFile=' + str(result_path)]
        record = {'id': mutant['id'], 'path': mutant['path'], 'command': command, 'killed': False}
        started = time.monotonic()
        try:
            mutant_deadline = min(started + manifest['per_mutant_budget_seconds'], deadline)
            if mutant_deadline <= started:
                raise RuntimeError('Total mutation budget exhausted')
            baseline_path = (args.output / (mutant['id'] + '-baseline.json')).resolve()
            baseline_command = command[:-1] + ['--outputFile=' + str(baseline_path)]
            baseline_exit = execute(baseline_command, args.output / (mutant['id'] + '-baseline.log'), mutant_deadline)
            baseline = json.loads(baseline_path.read_text())
            baseline_assertions = [assertion for suite in baseline['testResults']
                                   for assertion in suite['assertionResults']]
            baseline_executed = sum(assertion['status'] in ['passed', 'failed'] for assertion in baseline_assertions)
            record['baseline'] = {'exit_code': baseline_exit, 'executed': baseline_executed,
                                  'passed': baseline['numPassedTests'], 'failed': baseline['numFailedTests'],
                                  'runtime_suite_errors': baseline['numRuntimeErrorTestSuites']}
            if (baseline_exit != 0 or baseline_executed != 1 or baseline['numPassedTests'] != 1 or
                    baseline['numFailedTests'] != 0 or baseline['numRuntimeErrorTestSuites'] != 0):
                raise RuntimeError('Exact selector baseline is not one passing functional test')
            if path.read_bytes() != expected:
                raise RuntimeError('Baseline modified production source')
            path.write_bytes(expected.replace(before, mutant['after'].encode(), 1))
            run_exit = execute(command, log_path, mutant_deadline)
            record['exit_code'] = run_exit
            result = json.loads(result_path.read_text())
            failures = [assertion for suite in result['testResults'] for assertion in suite['assertionResults']
                        if assertion['status'] == 'failed']
            record['failed_assertions'] = [{'name': assertion['fullName'], 'messages': assertion['failureMessages']}
                                           for assertion in failures]
            record['failed_count'] = result['numFailedTests']
            record['passed_count'] = result['numPassedTests']
            record['runtime_suite_errors'] = result['numRuntimeErrorTestSuites']
            expected_failure = any(mutant['expected_assertion'] in assertion['fullName'] and
                                   any('expect(' in message for message in assertion['failureMessages'])
                                   for assertion in failures)
            record['killed'] = (run_exit != 0 and result['numFailedTests'] > 0 and
                                result['numRuntimeErrorTestSuites'] == 0 and expected_failure)
        except Exception as error:
            record['error'] = str(error)
        finally:
            path.write_bytes(expected)
            record['source_restored'] = path.read_bytes() == expected
            record['seconds'] = round(time.monotonic() - started, 3)
            summary['mutants'].append(record)
            (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
            print(json.dumps({key: record.get(key) for key in ['id', 'killed', 'failed_count', 'runtime_suite_errors',
                                                               'source_restored', 'seconds', 'error']}), flush=True)
    if len(summary['mutants']) != len(manifest['mutants']) or not all(
        item['killed'] and item['source_restored'] for item in summary['mutants']
    ):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
