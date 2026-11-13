#!/usr/bin/env python3
"""Exercise source-origin selection using a byte-identical supplied Bash test runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest


ORIGINAL_RUNNER_SHA256 = '3241aff49494d152d40aa3d545a7d02c4db5dd3c00989126e868e8a7d34cdce4'
IDENTITY = 't-origin.sh::test_origin_witness'
OWNED = (
    "printf 'owned-source\\n' >> \"$SOURCE_WITNESS_FILE\"\n"
    'test_origin_witness() {\n'
    "  printf 'owned-run\\n' >> \"$RUN_WITNESS_FILE\"\n"
    '  ok "owned origin witness"\n'
    '}\n'
)
FOREIGN = (
    "printf 'foreign-source\\n' >> \"$SOURCE_WITNESS_FILE\"\n"
    'test_origin_witness() {\n'
    "  printf 'foreign-run\\n' >> \"$RUN_WITNESS_FILE\"\n"
    '  ok "foreign origin witness"\n'
    '}\n'
)


class RunnerSourcePathsTests(unittest.TestCase):
    def setUp(self):
        # Force the no-space control outside any host checkout or TMPDIR containing spaces.
        temporary = tempfile.TemporaryDirectory(prefix='runner-source-paths-', dir='/tmp')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.assertFalse(any(character.isspace() for character in str(self.base)))
        self.logs = self.log_root / self._testMethodName
        self.logs.mkdir()

    def fixture(self, spaced=False, foreign=False):
        root = self.base / ('space root' if spaced else 'plain')
        tests = root / 'tests'
        tests.mkdir(parents=True)
        runner = tests / 'run-tests.sh'
        shutil.copyfile(self.runner, runner)
        self.assertEqual(hashlib.sha256(runner.read_bytes()).hexdigest(), ORIGINAL_RUNNER_SHA256)
        runner.chmod(stat.S_IMODE(self.runner.stat().st_mode))
        source = tests / 't-origin.sh'
        source.write_text(OWNED, encoding='utf-8')
        layout = self.logs / root.name
        layout.mkdir()
        if foreign:
            outside = tests / 'foreign' / 't-origin.sh'
            outside.parent.mkdir()
            outside.write_text(FOREIGN, encoding='utf-8')
            source.write_text(
                '. "$HERE/foreign/t-origin.sh"\n'
                'test_local_canary() {\n'
                "  printf 'local-run\\n' >> \"$RUN_WITNESS_FILE\"\n"
                '  ok "local canary"\n'
                '}\n', encoding='utf-8')
            (layout / 'foreign-t-origin.sh').write_bytes(outside.read_bytes())
        (layout / 't-origin.sh').write_bytes(source.read_bytes())
        (layout / 'root.txt').write_text(str(root) + '\n', encoding='utf-8')
        (layout / 'runner.sha256').write_text(hashlib.sha256(runner.read_bytes()).hexdigest() + '\n')
        return tests, layout

    def invoke(self, tests, layout, label, arguments, selectors=None):
        logs = layout / label
        logs.mkdir()
        environment = {
            name: value for name, value in os.environ.items()
            if not name.startswith(('REVIEW_COUNCIL_TEST_', 'REV_EVIDENCE_'))
            and name not in ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
                             'REVIEW_COUNCIL_CONTRACT_RUNNER', 'REVIEW_COUNCIL_CONTRACT_PROVIDER_VERSIONS')
            and not name.startswith('BASH_FUNC_')
        }
        environment.update(
            REVIEW_COUNCIL_HOST='pi', SOURCE_WITNESS_FILE=str(logs / 'source-witness.txt'),
            RUN_WITNESS_FILE=str(logs / 'run-witness.txt'))
        if selectors:
            environment.update(selectors)
        command = ['bash', '--noprofile', '--norc', *arguments]
        (logs / 'command.json').write_text(json.dumps(command) + '\n')
        process = subprocess.Popen(
            command, cwd=tests.parent, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        (logs / 'stdout.txt').write_bytes(stdout)
        (logs / 'stderr.txt').write_bytes(stderr)
        (logs / 'status.json').write_text(json.dumps({
            'returncode': process.returncode, 'timed_out': timed_out,
        }) + '\n')
        print(f'{self._testMethodName}/{layout.name}/{label}: status={process.returncode} timed_out={timed_out}', flush=True)
        self.assertFalse(timed_out, str(logs))
        return process.returncode, stdout.decode(), stderr.decode(), logs

    def metadata(self, tests, layout, foreign=False):
        status, stdout, stderr, logs = self.invoke(tests, layout, 'origin-metadata', [
            '-c', 'HERE=$1; shopt -s extdebug; . "$HERE/t-origin.sh"; declare -F test_origin_witness',
            'origin-metadata', str(tests),
        ])
        self.assertEqual(status, 0)
        self.assertEqual(stderr, '')
        origin = tests / 'foreign/t-origin.sh' if foreign else tests / 't-origin.sh'
        self.assertRegex(stdout, r'^test_origin_witness [0-9]+ ')
        self.assertTrue(stdout.endswith(' ' + str(origin) + '\n'), stdout)
        self.assertEqual((logs / 'source-witness.txt').read_text(), 'foreign-source\n' if foreign else 'owned-source\n')
        self.assertFalse((logs / 'run-witness.txt').exists())

    def positive(self, mode, spaced):
        tests, layout = self.fixture(spaced=spaced)
        self.metadata(tests, layout)
        results = layout / 'exact.results'
        selectors = {}
        arguments = [str(tests / 'run-tests.sh')]
        if mode == 'discovery':
            selectors['REVIEW_COUNCIL_TEST_DISCOVER'] = '1'
        elif mode == 'filter':
            arguments.append('origin')
        else:
            selectors.update(REVIEW_COUNCIL_TEST_TASK=IDENTITY, REVIEW_COUNCIL_TEST_RESULTS_FILE=str(results))
        status, stdout, stderr, logs = self.invoke(tests, layout, mode, arguments, selectors)
        self.assertEqual(status, 0, f'{mode}: {stdout!r} {stderr!r}; logs={logs}')
        self.assertEqual(stderr, '')
        self.assertTrue((logs / 'source-witness.txt').read_text().splitlines())
        if mode == 'discovery':
            self.assertEqual(stdout.splitlines(), [IDENTITY], f'full-path origin missing; logs={logs}')
            self.assertFalse((logs / 'run-witness.txt').exists())
        else:
            self.assertEqual((logs / 'run-witness.txt').read_text(), 'owned-run\n')
            self.assertIn('origin_witness\n  ok   owned origin witness\n', stdout)
            if mode == 'filter':
                self.assertIn('passed=1 failed=0\n', stdout)
            else:
                self.assertEqual(results.read_text(), 'ok\n')
        witness = 'exact discovery identity' if mode == 'discovery' else 'owned execution and nonzero assertion'
        print(f'CONTROL PASS {mode} layout={layout.name}: {witness} verified', flush=True)

    # On the original runner only each space-root case should fail, after its no-space control passes.
    def test_discovery_preserves_source_path(self):
        self.positive('discovery', spaced=False)
        self.positive('discovery', spaced=True)

    def test_substring_filter_preserves_source_path(self):
        self.positive('filter', spaced=False)
        self.positive('filter', spaced=True)

    def test_exact_identity_preserves_source_path(self):
        self.positive('exact', spaced=False)
        self.positive('exact', spaced=True)

    def test_foreign_source_cannot_masquerade_as_test_file(self):
        # Same basename, different literal source file; a basename-only fix must fail this guard.
        tests, layout = self.fixture(foreign=True)
        self.metadata(tests, layout, foreign=True)
        status, stdout, stderr, logs = self.invoke(tests, layout, 'discovery', [str(tests / 'run-tests.sh')], {
            'REVIEW_COUNCIL_TEST_DISCOVER': '1',
        })
        self.assertEqual((status, stdout.splitlines(), stderr), (0, ['t-origin.sh::test_local_canary'], ''))
        self.assertEqual((logs / 'source-witness.txt').read_text(), 'foreign-source\n')
        self.assertFalse((logs / 'run-witness.txt').exists())
        status, stdout, stderr, logs = self.invoke(tests, layout, 'local-canary', [str(tests / 'run-tests.sh'), 'local_canary'])
        self.assertEqual((status, stderr), (0, ''))
        self.assertIn('passed=1 failed=0\n', stdout)
        self.assertEqual((logs / 'run-witness.txt').read_text(), 'local-run\n')
        status, stdout, stderr, logs = self.invoke(tests, layout, 'foreign-filter', [str(tests / 'run-tests.sh'), 'origin_witness'])
        self.assertEqual((status, stderr), (1, ''))
        self.assertIn("FAIL no test matched - filter 'origin_witness' selected nothing", stdout)
        self.assertIn('passed=0 failed=1\n', stdout)
        self.assertIn('foreign-source\n', (logs / 'source-witness.txt').read_text())
        self.assertFalse((logs / 'run-witness.txt').exists())
        results = layout / 'foreign.results'
        status, stdout, stderr, logs = self.invoke(tests, layout, 'foreign-exact', [str(tests / 'run-tests.sh')], {
            'REVIEW_COUNCIL_TEST_TASK': IDENTITY, 'REVIEW_COUNCIL_TEST_RESULTS_FILE': str(results),
        })
        self.assertEqual((status, stdout, stderr), (2, '', f'run-tests: unknown exact test identity: {IDENTITY}\n'))
        self.assertEqual(results.read_bytes(), b'')
        self.assertEqual((logs / 'source-witness.txt').read_text(), 'foreign-source\n')
        self.assertFalse((logs / 'run-witness.txt').exists())
        print('CONTROL PASS foreign source: real definition sourced, local assertion executed, discovery/filter/exact refused foreign identity', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', required=True, type=Path)
    parser.add_argument('--logs', required=True, type=Path)
    args = parser.parse_args()
    metadata = args.runner.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        parser.error('supplied runner must be a regular single-link file')
    if hashlib.sha256(args.runner.read_bytes()).hexdigest() != ORIGINAL_RUNNER_SHA256:
        parser.error('supplied runner does not match the immutable original runner')
    args.logs.mkdir()
    (args.logs / 'supplied-runner.json').write_text(json.dumps({
        'path': str(args.runner.resolve(strict=True)), 'sha256': ORIGINAL_RUNNER_SHA256,
        'mode': stat.S_IMODE(metadata.st_mode),
    }) + '\n')
    RunnerSourcePathsTests.runner = args.runner.resolve(strict=True)
    RunnerSourcePathsTests.log_root = args.logs.resolve(strict=True)
    unittest.main(argv=[sys.argv[0]], verbosity=2)


if __name__ == '__main__':
    main()
