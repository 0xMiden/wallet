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
            self.assertEqual(red.capability_diagnostic(transcript + start + end + b'127\n', b'', 127), {
                'capability_step': step, 'capability_category': 'STEP_FAILED', 'capability_exit': 127,
                'capability_error_category': 'NONE'})
            self.assertEqual(red.capability_diagnostic(transcript + start, b'', 124), {
                'capability_step': step, 'capability_category': 'INCOMPLETE', 'capability_exit': -1,
                'capability_error_category': 'NONE'})
            transcript += start + end + b'0\n'
        # Unknown stderr cannot obscure controlled success/first-tool markers.
        self.assertEqual(red.capability_diagnostic(transcript, b'unknown private stderr', 0), {
            'capability_step': 'COMPLETE', 'capability_category': 'PASSED', 'capability_exit': 0,
            'capability_error_category': 'UNKNOWN'})
        for stderr, category in red.BWRAP_ERRORS.items():
            self.assertEqual(red.capability_diagnostic(b'', stderr, 1), {
                'capability_step': 'SANDBOX_LAUNCH', 'capability_category': 'SANDBOX_LAUNCH_FAILED',
                'capability_exit': 1, 'capability_error_category': category})

    def test_capability_unknown_and_secret_text_never_exported(self):
        secret = b'PRIVATE_TOKEN=/private/secret Authorization: bearer NEVER_EXPORT\n'
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            output = work / 'infrastructure.json'
            for markers, stderr in ((b'', secret), (b'', b'bwrap: setting up uid map: Permission denied\n' + secret),
                                    (secret, secret)):
                (work / 'capability.log').write_bytes(markers)
                (work / 'capability.stderr').write_bytes(stderr)
                (work / 'namespace-probe.stdout').write_bytes(secret)
                (work / 'namespace-probe.stderr').write_bytes(secret)
                red.infrastructure(output, 'capability', 1, work)
                record = json.loads(output.read_text())
                self.assertEqual(record['capability_category'], 'UNKNOWN' if markers else 'SANDBOX_LAUNCH_FAILED')
                self.assertEqual(record['capability_error_category'], 'UNKNOWN')
                self.assertNotIn(secret, output.read_bytes())
            start = b'MINIMUM_CAPABILITY:PYTHON:START\n'
            bash = b'MINIMUM_CAPABILITY:BASH:START\nMINIMUM_CAPABILITY:BASH:EXIT:0\n'
            result = red.capability_diagnostic(bash + start + b'MINIMUM_CAPABILITY:PYTHON:EXIT:127\n', secret, 127)
            self.assertEqual(result['capability_step'], 'PYTHON')
            self.assertEqual(result['capability_category'], 'STEP_FAILED')
            for log in (secret, bash + start + secret, bash + b'MINIMUM_CAPABILITY:PYTHON:START\nMINIMUM_CAPABILITY:PYTHON:EXIT:999\n'):
                self.assertEqual(red.capability_diagnostic(log, secret, 1)['capability_category'], 'UNKNOWN')

    def test_kernel_eligibility_only_zero_positive_or_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            self.assertEqual(set(red.kernel_eligibility(proc).values()), {'UNKNOWN'})
            for raw, expected in [(b'0\n', 'ZERO'), (b'1\n', 'POSITIVE'), (b'65536\n', 'POSITIVE'),
                                  (b'-1\n', 'UNKNOWN'), (b'PRIVATE_TOKEN=secret', 'UNKNOWN'),
                                  (b'9' * 5000, 'UNKNOWN')]:
                for name in red.KERNEL_SETTINGS:
                    path = proc / name.replace('.', '/')
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw)
                self.assertEqual(red.kernel_eligibility(proc), dict.fromkeys(red.KERNEL_SETTINGS, expected))

    def test_namespace_probe_status_is_numeric_and_coarse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'namespace-probe.exit'
            for code, category in [(-1, 'NOT_ATTESTED'), (0, 'PASSED'), (1, 'FAILED'),
                                   (124, 'TIMEOUT'), (126, 'UNAVAILABLE'), (127, 'UNAVAILABLE'), (137, 'FAILED')]:
                if code >= 0:
                    path.write_text(str(code) + '\n')
                actual = red.private_exit(path)
                self.assertEqual(red.namespace_probe_diagnostic(actual), {
                    'namespace_probe_exit': code, 'namespace_probe_category': category})
            for raw in (b'999\n', b'0\nsecret', b'PRIVATE_TOKEN=secret'):
                path.write_bytes(raw)
                self.assertEqual(red.private_exit(path), -1)

    def test_selfcheck_attestation_requires_zero_return_and_actual_count(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / 'selfcheck.count').write_bytes(b'37\n')
            self.assertEqual(red.selfcheck_attestation(work)['selfcheck_category'], 'NOT_ATTESTED')
            (work / 'selfcheck.exit').write_bytes(b'0\n')
            self.assertEqual(red.selfcheck_attestation(work), {'selfcheck_category': 'PASSED', 'selfcheck_count': 37})
            (work / 'selfcheck.exit').write_bytes(b'1\n')
            self.assertEqual(red.selfcheck_attestation(work)['selfcheck_category'], 'NOT_ATTESTED')
            (work / 'selfcheck.exit').write_bytes(b'0\n')
            (work / 'selfcheck.count').write_bytes(b'37\nPRIVATE_TOKEN=secret')
            self.assertEqual(red.selfcheck_attestation(work)['selfcheck_count'], -1)

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
        self.assertIn('> "$work/capability.log" 2> "$work/capability.stderr"', shell)
        self.assertEqual(shell.count('/usr/bin/unshare --user --map-root-user /usr/bin/true'), 1)
        self.assertIn('timeout --signal=TERM --kill-after=1s 5s env -i', shell)
        self.assertIn('printf \'0\\n\' > "$work/selfcheck.exit"', shell)
        for option in ('--unshare-all', '--clearenv', '--ro-bind "$work/runtime" /runtime',
                       '--setenv HOME /state/home', '--setenv PATH /tools', '--tmpfs /tmp'):
            self.assertIn(option, shell)
        marker = '${{ runner.temp }}/minimum-source-union-red-public/'
        uploaded = {line.strip()[len(marker):] for line in workflow.splitlines() if line.strip().startswith(marker)}
        self.assertEqual(uploaded, red.PUBLIC_FILES)
        self.assertNotIn('*.log', workflow)
        self.assertNotIn('red.results', workflow)


if __name__ == '__main__':
    program = unittest.main(exit=False)
    if not program.result.wasSuccessful():
        raise SystemExit(1)
    print(program.result.testsRun)
