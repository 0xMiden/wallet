import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


TARGET = 'test_real_cli_audit_exit_and_output_preserve_the_ledger_and_coassignees'
TRACE_ASSERTION = """                self.assertEqual(attempts, [
                    ['api', '--method', 'GET', 'repos/0xMiden/wallet/issues/100']
                ])"""
OLD_ASSERTION = "                self.assertEqual(payload['assignees'], [{'login': login} for login in assignees])"
ANCHOR = "        result = subprocess.run(['gh', 'api', '--method', 'GET',"
MUTATION = """        if __name__ == '__main__':
            subprocess.run(['gh', 'issue', 'edit', str(number), '--add-assignee', 'nobody'],
                           check=False, capture_output=True, text=True, timeout=20)
"""


def case(directory, output):
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('sensitivity_ownership', directory / 'test_ownership.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    test = module.PublicOwnershipTest(TARGET)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([test]))
    observed = {'run': result.testsRun,
                'failures': [{'test': item.id(), 'traceback': trace} for item, trace in result.failures],
                'errors': [{'test': item.id(), 'traceback': trace} for item, trace in result.errors],
                'skipped': [(item.id(), reason) for item, reason in result.skipped],
                'attempts': test.cli_trace_observations}
    output.write_text(json.dumps(observed, indent=2) + '\n')
    return 0 if result.wasSuccessful() else 1


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--case':
        return case(Path(sys.argv[2]), Path(sys.argv[3]))
    source = Path(__file__).resolve().parent
    output = Path(os.environ['OWNERSHIP_RESULTS'])
    baseline = {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                for name in ('ledger.py', 'test_ownership.py', 'run_tests.py', 'run_sensitivity.py')}
    rows = []
    with tempfile.TemporaryDirectory(prefix='ownership-command-sensitivity-') as temporary:
        for mutant in (False, True):
            for corrected in (False, True):
                label = ('mutant' if mutant else 'control') + ('-new' if corrected else '-old')
                directory = Path(temporary) / label
                directory.mkdir()
                ledger = (source / 'ledger.py').read_text()
                tests = (source / 'test_ownership.py').read_text()
                if mutant:
                    assert ledger.count(ANCHOR) == 1
                    ledger = ledger.replace(ANCHOR, MUTATION + ANCHOR, 1)
                if not corrected:
                    assert tests.count(TRACE_ASSERTION) == 1
                    tests = tests.replace(TRACE_ASSERTION, OLD_ASSERTION, 1)
                (directory / 'ledger.py').write_text(ledger)
                (directory / 'test_ownership.py').write_text(tests)
                command = [sys.executable, '-B', str(Path(__file__).resolve()), '--case',
                           str(directory), str(output / (label + '.json'))]
                completed = subprocess.run(command, capture_output=True, text=True, timeout=30)
                (output / (label + '.stdout')).write_text(completed.stdout)
                (output / (label + '.stderr')).write_text(completed.stderr)
                observed = json.loads((output / (label + '.json')).read_text())
                expected_code = 1 if mutant and corrected else 0
                assert completed.returncode == expected_code, (label, completed.returncode, completed.stderr)
                assert observed['run'] == 1 and not observed['errors'] and not observed['skipped'], observed
                assert len(observed['failures']) == (2 if mutant and corrected else 0), observed
                assert len(observed['attempts']) == 2, observed
                for assigned, trace in zip((False, True), observed['attempts']):
                    expected = [['api', '--method', 'GET', 'repos/0xMiden/wallet/issues/100']]
                    if mutant:
                        expected.insert(0, ['issue', 'edit', '100', '--add-assignee', 'nobody'])
                    assert trace['assigned'] is assigned and trace['attempts'] == expected, trace
                    assert trace['returncode'] == (0 if assigned else 2), trace
                if mutant and corrected:
                    for failure in observed['failures']:
                        assert 'self.assertEqual(attempts, [' in failure['traceback'], failure
                        assert "'issue', 'edit', '100', '--add-assignee', 'nobody'" in failure['traceback'], failure
                rows.append({'label': label, 'argv': command, 'exit_code': completed.returncode,
                             'expected_exit': expected_code, 'test_source_sha256': hashlib.sha256(tests.encode()).hexdigest(),
                             'ledger_source_sha256': hashlib.sha256(ledger.encode()).hexdigest(),
                             'observed': observed})
    assert baseline == {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in baseline}
    (output / 'sensitivity.json').write_text(json.dumps({
        'status': 'EXACT_PRIVATE_IGNORED_COMMAND_OLD_NEW_SENSITIVITY', 'cases': rows,
        'source_sha256': baseline, 'public_mutation': False,
        'boundary': 'Every gh child uses the private GET-only rejecting shim.'}, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
