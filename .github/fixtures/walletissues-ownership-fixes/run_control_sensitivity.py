import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


IMPORT_GUARD = "if __name__ == '__main__':\n    raise SystemExit(main())"
CONTROLLER_GUARD = "if name in ('walletissues_adopt','walletissues_mine') and not ownership_ok:"


def case(directory, kind, output):
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('sensitivity_ownership', directory / 'test_ownership.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if kind == 'import':
        test = module.RunnerImportTest('test_import_without_ci_environment_has_no_execution_side_effects')
    else:
        test = module.HeartbeatAdmissionTest('test_failed_or_timed_out_audit_skips_adopt_and_mine')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([test]))
    output.write_text(json.dumps({'tests_run': result.testsRun,
        'failures': [{'test': item.id(), 'traceback': trace} for item, trace in result.failures],
        'errors': [{'test': item.id(), 'traceback': trace} for item, trace in result.errors],
        'skipped': [(item.id(), reason) for item, reason in result.skipped],
        'observations': getattr(test, 'observations', [])}, indent=2) + '\n')
    return 0 if result.wasSuccessful() else 1


def main():
    if len(sys.argv) == 5 and sys.argv[1] == '--case':
        return case(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    source = Path(__file__).resolve().parent
    output = Path(os.environ['OWNERSHIP_RESULTS'])
    rows = []
    with tempfile.TemporaryDirectory(prefix='ownership-control-sensitivity-') as temporary:
        for kind in ('import', 'controller'):
            for mutant in (False, True):
                label = kind + ('-mutant' if mutant else '-control')
                directory = Path(temporary) / label
                directory.mkdir()
                for name in ('ledger.py', 'test_ownership.py', 'run_tests.py', 'controller/heartbeat.py'):
                    target = directory / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source / name, target)
                changed = directory / ('run_tests.py' if kind == 'import' else 'controller/heartbeat.py')
                before = changed.read_text()
                if mutant:
                    needle = IMPORT_GUARD if kind == 'import' else CONTROLLER_GUARD
                    replacement = ('if True:\n    raise SystemExit(main())' if kind == 'import' else
                                   "if name in ('walletissues_adopt','walletissues_mine') and ownership_ok:")
                    assert before.count(needle) == 1
                    changed.write_text(before.replace(needle, replacement, 1))
                private_reports = directory / 'reports'
                private_reports.mkdir()
                command = [sys.executable, '-B', str(Path(__file__).resolve()), '--case',
                           str(directory), kind, str(output / (label + '.json'))]
                completed = subprocess.run(command, capture_output=True, text=True, timeout=30,
                                           env={**os.environ, 'OWNERSHIP_RESULTS': str(private_reports)})
                (output / (label + '.stdout')).write_text(completed.stdout)
                (output / (label + '.stderr')).write_text(completed.stderr)
                observed = json.loads((output / (label + '.json')).read_text())
                assert completed.returncode == (1 if mutant else 0), (label, completed.stderr)
                assert observed['tests_run'] == 1 and not observed['errors'] and not observed['skipped'], observed
                assert len(observed['failures']) == ((1 if kind == 'import' else 2) if mutant else 0), observed
                if mutant and kind == 'import':
                    trace = observed['failures'][0]['traceback']
                    assert 'self.assertEqual(result.returncode, 0, result.stderr)' in trace
                    assert "KeyError: 'OWNERSHIP_RESULTS'" in trace
                if kind == 'controller':
                    assert [row['audit'] for row in observed['observations']] == ['failed', 'timeout']
                    for row, code in zip(observed['observations'], (2, 124)):
                        assert row['exception'] is None
                        assert row['state']['results']['walletissues_ownership_audit']['exit_code'] == code
                        attempted = [name for name in row['names'] if name in ('walletissues_adopt', 'walletissues_mine')]
                        assert attempted == (['walletissues_adopt', 'walletissues_mine'] if mutant else []), row
                    if mutant:
                        for failure in observed['failures']:
                            assert 'in assert_blocked' in failure['traceback']
                            assert "['walletissues_adopt', 'walletissues_mine'] != []" in failure['traceback']
                rows.append({'label': label, 'argv': command, 'exit_code': completed.returncode,
                             'source_before': before, 'source_after': changed.read_text(), 'observed': observed})
    (output / 'control-sensitivity.json').write_text(json.dumps({
        'status': 'EXACT_PRIVATE_IMPORT_AND_INVERSE_ADMISSION_SENSITIVITY', 'cases': rows,
        'limits': 'Private source copies only; no installed controller, default ledger or real gh.'}, indent=2) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
