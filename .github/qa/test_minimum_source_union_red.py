"""CI-only data self-checks for the minimum controller, never project/runner execution."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

QA = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('minimum_red', QA / 'minimum-source-union-red.py')
red = importlib.util.module_from_spec(spec)
spec.loader.exec_module(red)


class MinimumSourceUnionRedTests(unittest.TestCase):
    def setUp(self):
        self.baseline = red.read_manifest('B')
        self.minimum = red.read_manifest('M')

    def test_exact_b171_m171_and_all_archive_bytes(self):
        red.validate_overlay(self.baseline, self.minimum)
        self.assertEqual(sum(self.baseline[n] == self.minimum[n] for n in self.baseline), 170)
        for identity, members in [('B', self.baseline), ('M', self.minimum)]:
            with zipfile.ZipFile(QA / ('minimum-source-union-red-%s.zip' % identity)) as bundle:
                red.validate_archive(bundle, members)

    def test_reject_wrong_member_count_and_paths(self):
        for count in (169, 170, 172, 400, True):
            with self.subTest(count=count), self.assertRaises(ValueError):
                red.validate_manifest({'member_count': count, 'members': self.minimum})
        for name in ('', '.', '../escape', '/absolute', 'tests/../escape', 'tests//a', './a', 'a\\b', 'a\x00b'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                red.valid_path(name)
        red.valid_path(red.TARGET)
        manifest = {'member_count': 171, 'members': copy.deepcopy(self.minimum)}
        manifest['members']['tests'] = manifest['members'].pop(red.TARGET)
        with self.assertRaises(ValueError):
            red.validate_manifest(manifest)

    def test_reject_extra_changed_member_missing_member_mode_or_overlay(self):
        mutations = []
        row = copy.deepcopy(self.minimum)
        row['tests/test-costs.tsv']['sha256'] = '0' * 64
        mutations.append(row)
        row = copy.deepcopy(self.minimum)
        row.pop('tests/test-costs.tsv')
        mutations.append(row)
        row = copy.deepcopy(self.minimum)
        row[red.TARGET]['mode'] = 0o755
        mutations.append(row)
        row = copy.deepcopy(self.minimum)
        row[red.TARGET]['sha256'] = '0' * 64
        mutations.append(row)
        mutations.append(self.baseline)
        for index, minimum in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(ValueError):
                red.validate_overlay(self.baseline, minimum)

    def test_runner_and_compiler_are_exact(self):
        for name in ('tests/run-tests.sh', 'scripts/rev-evidence.py'):
            baseline, minimum = copy.deepcopy(self.baseline), copy.deepcopy(self.minimum)
            baseline[name]['sha256'] = minimum[name]['sha256'] = '0' * 64
            with self.subTest(name=name), self.assertRaises(ValueError):
                red.validate_overlay(baseline, minimum)

    def test_archive_rejects_duplicates_directories_symlinks_modes_sizes_hashes_and_paths(self):
        raw = b'public fixture\n'
        members = {'fixture': {'bytes': len(raw), 'sha256': red.sha(raw), 'mode': 0o644}}
        cases = [
            [('fixture', stat.S_IFREG | 0o644, raw)],
            [('fixture', stat.S_IFREG | 0o644, raw)] * 2,
            [('fixture/', stat.S_IFDIR | 0o755, b'')],
            [('fixture', stat.S_IFLNK | 0o644, raw)],
            [('fixture', stat.S_IFREG | 0o755, raw)],
            [('fixture', stat.S_IFREG | 0o644, raw + b'x')],
            [('fixture', stat.S_IFREG | 0o644, b'x' * len(raw))],
            [('../escape', stat.S_IFREG | 0o644, raw)],
        ]
        for index, rows in enumerate(cases):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as bundle:
                for name, mode, data in rows:
                    item = zipfile.ZipInfo(name)
                    item.external_attr = mode << 16
                    bundle.writestr(item, data)
            buffer.seek(0)
            with self.subTest(index=index), zipfile.ZipFile(buffer) as bundle:
                if index == 0:
                    red.validate_archive(bundle, members)
                else:
                    with self.assertRaises(ValueError):
                        red.validate_archive(bundle, members)

    def test_only_exact_expected_failure_after_setup_is_red(self):
        self.assertTrue(red.accepted_red(1, red.EXPECTED_LOG, b'ok\nfail\n'))
        cases = [
            (0, red.EXPECTED_LOG, b'ok\nfail\n'),
            (124, red.EXPECTED_LOG, b'ok\nfail\n'),
            (137, red.EXPECTED_LOG, b'ok\nfail\n'),
            (1, b'', b''),
            (1, red.EXPECTED_LOG, b'ok\nfail'),
            (1, red.EXPECTED_LOG, b'ok\r\nfail\r\n'),
            (1, red.EXPECTED_LOG, b'ok\nfail\nfail\n'),
            (1, red.SETUP + red.HEADER + red.FAILURE, b'ok\nfail\n'),
            (1, red.HEADER + red.FAILURE, b'ok\nfail\n'),
            (1, red.EXPECTED_LOG + red.HEADER, b'ok\nfail\n'),
            (1, red.EXPECTED_LOG.replace(red.HEADER, b'other_task\n'), b'ok\nfail\n'),
            (1, red.EXPECTED_LOG.replace(red.SETUP, b'  FAIL setup\n'), b'ok\nfail\n'),
            (1, red.EXPECTED_LOG.replace(red.FAILURE, b'  FAIL schema/import error\n'), b'ok\nfail\n'),
            (1, red.EXPECTED_LOG + b'Traceback: setup error\n', b'ok\nfail\n'),
        ]
        for index, args in enumerate(cases):
            with self.subTest(index=index):
                self.assertFalse(red.accepted_red(*args))

    def test_public_export_is_fixed_even_for_arbitrary_assertion_and_manifest_text(self):
        with tempfile.TemporaryDirectory() as directory:
            public = Path(directory)
            self.assertTrue(red.export_result(public, 1, red.EXPECTED_LOG, b'ok\nfail\n'))
            self.assertEqual((public / 'semantic-red.txt').read_text(), red.SUMMARY)
            secret = b'NEVER_EXPORT_ARBITRARY_TEXT'
            self.assertFalse(red.export_result(public, 1,
                red.HEADER + red.SETUP + b'  FAIL ' + secret + b'\nmanifest=' + secret,
                b'ok\nfail\n'))
            self.assertFalse((public / 'semantic-red.txt').exists())
            self.assertEqual({p.name for p in public.iterdir()}, {'outcomes.json'})
            self.assertNotIn(secret, (public / 'outcomes.json').read_bytes())
            outcome = json.loads((public / 'outcomes.json').read_text())
            self.assertTrue(all(type(value) in (int, bool) for value in outcome.values()))

    def test_capability_diagnostic_success_and_first_failed_step(self):
        transcript = b''
        for step in red.CAPABILITY_STEPS:
            start = ('MINIMUM_CAPABILITY:' + step + ':START\n').encode()
            end = ('MINIMUM_CAPABILITY:' + step + ':EXIT:').encode()
            self.assertEqual(red.capability_diagnostic(transcript + start + end + b'127\n', 127), {
                'capability_step': step, 'capability_category': 'STEP_FAILED', 'capability_exit': 127})
            self.assertEqual(red.capability_diagnostic(transcript + start, 124), {
                'capability_step': step, 'capability_category': 'INCOMPLETE', 'capability_exit': -1})
            transcript += start + end + b'0\n'
        self.assertEqual(red.capability_diagnostic(transcript, 0), {
            'capability_step': 'COMPLETE', 'capability_category': 'PASSED', 'capability_exit': 0})
        for log, step, category in [
            (b'bwrap: Creating new namespace failed: Operation not permitted\n', 'NAMESPACE', 'NAMESPACE_DENIED'),
            (b'bwrap: execvp /tools/bash: No such file or directory\n', 'LOADER', 'LOADER_FAILED'),
        ]:
            self.assertEqual(red.capability_diagnostic(log, 1), {
                'capability_step': step, 'capability_category': category, 'capability_exit': -1})

    def test_capability_unknown_and_secret_text_never_exported(self):
        secret = b'PRIVATE_TOKEN=/private/secret Authorization: bearer NEVER_EXPORT\n'
        logs = [b'', secret, b'bwrap: ' + secret,
                b'bwrap: Creating new namespace failed: Operation not permitted\n' + secret,
                b'MINIMUM_CAPABILITY:BASH:START\n' + secret,
                b'MINIMUM_CAPABILITY:BASH:START\nMINIMUM_CAPABILITY:BASH:EXIT:999\n']
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / 'capability.log'
            output = Path(directory) / 'infrastructure.json'
            for log in logs:
                private.write_bytes(log)
                red.infrastructure(output, 'capability', 1, private)
                self.assertEqual(json.loads(output.read_text()), {
                    'stage': 'capability', 'raw_exit': 1, 'capability_step': 'UNKNOWN',
                    'capability_category': 'UNKNOWN', 'capability_exit': -1})
                self.assertNotIn(secret, output.read_bytes())

    def test_bound_shell_selector_sandbox_and_workflow_export_allowlist(self):
        shell = (QA / 'minimum-source-union-red.sh').read_text()
        workflow = (QA.parent / 'workflows/e2e-dapp-browser.yml').read_text()
        self.assertEqual(shell.count('REVIEW_COUNCIL_TEST_TASK=' + red.SELECTOR), 1)
        self.assertNotIn('REVIEW_COUNCIL_TEST_DISCOVER=1', shell)
        self.assertNotIn('inventory.txt', shell + workflow)
        self.assertNotIn('PHASE', shell)
        for step in red.CAPABILITY_STEPS:
            self.assertIn('capability_check ' + step + ' ', shell)
        self.assertIn('if command -v "$provider" >/dev/null 2>&1; then return 1; fi', shell)
        for option in ('--unshare-all', '--clearenv', '--ro-bind "$work/runtime" /runtime',
                       '--setenv HOME /state/home', '--setenv PATH /tools', '--tmpfs /tmp'):
            self.assertIn(option, shell)
        marker = '${{ runner.temp }}/minimum-source-union-red-public/'
        uploaded = {line.strip()[len(marker):] for line in workflow.splitlines() if line.strip().startswith(marker)}
        self.assertEqual(uploaded, red.PUBLIC_FILES)
        self.assertNotIn('*.log', workflow)
        self.assertNotIn('red.results', workflow)


if __name__ == '__main__':
    unittest.main()
