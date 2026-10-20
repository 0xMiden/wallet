import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

class Result(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = []
        self.passed = []

    def startTest(self, test):
        self.started.append(test.id())
        super().startTest(test)

    def addSuccess(self, test):
        self.passed.append(test.id())
        super().addSuccess(test)


def main():
    root = Path(__file__).resolve().parent
    output = Path(os.environ['OWNERSHIP_RESULTS'])
    output.mkdir(parents=True, exist_ok=True)
    source = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(root.glob('*.py'))}

    fake_gh = tempfile.TemporaryDirectory(prefix='ownership-fake-gh-')
    shim = Path(fake_gh.name) / 'gh'
    shim.write_text('#!' + sys.executable + '\n' +
                    "import json, re, sys\n"
                    "if len(sys.argv) != 5 or sys.argv[1:4] != ['api', '--method', 'GET']:\n"
                    "    raise SystemExit(17)\n"
                    "match = re.fullmatch(r'repos/0xMiden/wallet/issues/([0-9]+)', sys.argv[4])\n"
                    "if not match: raise SystemExit(17)\n"
                    "print(json.dumps({'number': int(match.group(1)), 'state': 'open',\n"
                    "                  'assignees': [{'login': 'co-owner'}, {'login': 'WiktorStarczewski'}]}))\n")
    shim.chmod(0o700)
    os.environ['PATH'] = str(shim.parent) + os.pathsep + os.environ['PATH']
    fixture_get = subprocess.run([str(shim), 'api', '--method', 'GET', 'repos/0xMiden/wallet/issues/7'],
                                 capture_output=True, text=True, timeout=5, check=True)
    if json.loads(fixture_get.stdout) != {'number': 7, 'state': 'open', 'assignees': [
            {'login': 'co-owner'}, {'login': 'WiktorStarczewski'}]}:
        raise SystemExit('invalid fake GitHub GET fixture')
    fixture_mutation = subprocess.run([str(shim), 'issue', 'edit', '7', '--add-assignee', 'nobody'],
                                      capture_output=True, text=True, timeout=5)
    if fixture_mutation.returncode != 17 or fixture_mutation.stdout:
        raise SystemExit('fake GitHub accepted a non-GET command')

    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(name)
                               for name in ('test_ledger', 'test_ownership'))
    result = unittest.TextTestRunner(verbosity=2, resultclass=Result).run(suite)
    report = {'tests_run': result.testsRun, 'started': result.started, 'passed': result.passed,
              'failures': [{'test': case.id(), 'traceback': trace} for case, trace in result.failures],
              'errors': [{'test': case.id(), 'traceback': trace} for case, trace in result.errors],
              'skipped': [(case.id(), reason) for case, reason in result.skipped],
              'expected_failures': [(case.id(), trace) for case, trace in result.expectedFailures],
              'unexpected_successes': [case.id() for case in result.unexpectedSuccesses],
              'source_sha256': source, 'commit': os.environ['GITHUB_SHA'],
              'run_id': os.environ['GITHUB_RUN_ID'],
              'fake_gh_get_exit': fixture_get.returncode,
              'fake_gh_non_get_exit': fixture_mutation.returncode,
              'fake_gh_sha256': hashlib.sha256(shim.read_bytes()).hexdigest()}
    (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    after = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(root.glob('*.py'))}
    if source != after:
        raise SystemExit('test source changed during execution')
    fake_gh.cleanup()
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
