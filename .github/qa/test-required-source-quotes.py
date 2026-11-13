#!/usr/bin/env python3
"""Permission regressions only: no source-range proof or receipt certification."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import shlex
import sys
import tempfile
import unittest


class RequiredSourceQuotesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='required-source-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'repo'
        self.root.mkdir()

    def artifacts(self, directory='session'):
        self.session = self.base / directory
        self.session.mkdir()
        self.prompt = self.session / 'r1-seat.prompt.md'
        self.segment = self.session / 'r1-seat-source-segment-001-001.txt'
        self.sibling = self.session / 'r1-seat-source-segment-001-002.txt'
        self.raw = b'1: exact source line\n'
        self.segment.write_bytes(self.raw)
        self.sibling.write_bytes(b'2: undeclared source line\n')

    def declaration(self, command):
        return (
            f'Required source segment 1/1: run {command} raw bytes {len(self.raw)}'
            f' visible bytes {len(self.raw)} content SHA-256 {hashlib.sha256(self.raw).hexdigest()}'
        )

    def permissions(self, declaration):
        self.prompt.write_text('## Scope\n' + declaration + '\n', encoding='utf-8')
        return self.audit.prompt_permissions(self.prompt, self.root, self.session)

    def command(self, path):
        return shlex.join(['cat', '--', str(path)])

    def violations(self, path, authorized, complete):
        return self.audit.shell_violations(
            self.command(path), self.audit.allowed_roots(self.root, self.session),
            self.root, self.session, authorized, complete,
        )

    def assert_authorized(self, authorized, complete):
        # Separate subtests ensure the real shell validator is reached even on baseline RED.
        with self.subTest(check='authorized'):
            self.assertEqual(authorized, {self.prompt, self.segment})
        with self.subTest(check='complete'):
            self.assertEqual(complete, {self.prompt, self.segment})
        with self.subTest(check='session membership'):
            self.assertTrue(self.audit.session_path_allowed(self.segment, self.session, authorized))
        with self.subTest(check='actual cat command'):
            self.assertEqual(self.violations(self.segment, authorized, complete), [])

    def positive(self, directory):
        self.artifacts(directory)
        self.assert_authorized(*self.permissions(self.declaration(self.command(self.segment))))

    # Mutation prediction: reverting to the original regex kills space/apostrophe
    # positives (exact sets and cat denial); plain canonical output stays a control.
    def test_canonical_plain_session(self):
        self.positive('session')

    def test_canonical_space_session(self):
        self.positive('session with spaces')

    def test_canonical_apostrophe_session(self):
        self.positive("session's artifacts")

    # Mutation prediction: authorizing every recognized session filename kills this
    # sibling denial in both permission sets, session membership and actual cat.
    def test_undeclared_sibling(self):
        self.artifacts()
        authorized, complete = self.permissions(self.declaration(self.command(self.segment)))
        self.assert_authorized(authorized, complete)
        self.assert_denied(self.sibling, authorized, complete)

    def assert_denied(self, path, authorized, complete):
        self.assertNotIn(path, authorized)
        self.assertNotIn(path, complete)
        self.assertFalse(self.audit.session_path_allowed(path, self.session, authorized))
        self.assertEqual(self.violations(path, authorized, complete), [
            {'code': 'unnamed-session-artifact', 'tool': 'Bash'},
        ])

    # Mutation prediction: dropping the exact session-parent guard grants the
    # outside artifact and removes the shell path-outside-scope denial.
    def test_outside_session_artifact(self):
        self.artifacts()
        outside = self.base / self.segment.name
        outside.write_bytes(self.raw)
        authorized, complete = self.permissions(self.declaration(self.command(outside)))
        self.assertEqual(authorized, {self.prompt})
        self.assertEqual(complete, {self.prompt})
        # This helper constrains session members only; roots constrain outside files.
        self.assertTrue(self.audit.session_path_allowed(outside, self.session, authorized))
        self.assertEqual(self.violations(outside, authorized, complete), [
            {'code': 'path-outside-scope', 'tool': 'Bash'},
        ])

    # Mutation prediction: accepting malformed quoting or generic prose fallback
    # can grant the real operand. The unmatched-opening case also exposes baseline
    # regex authorization; trailing-unmatched-quote is a baseline denial control.
    def test_malformed_quoting(self):
        self.artifacts()
        for command in (f"cat -- '{self.segment}", f"cat -- {self.segment}'"):
            with self.subTest(command=command):
                self.assert_denied(self.segment, *self.permissions(self.declaration(command)))

    # Mutation prediction: accepting multiple operands grants at least one real
    # artifact; both operands must stay denied, not merely one diagnostic string.
    def test_extra_operands(self):
        self.artifacts()
        command = shlex.join(['cat', '--', str(self.segment), str(self.sibling)])
        authorized, complete = self.permissions(self.declaration(command))
        for path in (self.segment, self.sibling):
            with self.subTest(path=path):
                self.assert_denied(path, authorized, complete)

    # Mutation prediction: parsing just the cat prefix of a compound declaration
    # grants the segment. Baseline may retain a bogus suffixed path, never the file.
    def test_pipeline_and_suffix_commands(self):
        self.artifacts()
        for suffix in (' | head -n 1', '; true', ' && true'):
            with self.subTest(suffix=suffix):
                authorized, complete = self.permissions(
                    self.declaration(self.command(self.segment) + suffix))
                self.assert_denied(self.segment, authorized, complete)

    # Mutation prediction: removing legacy/native Read recognition kills exact
    # authorization and the real cat check; shell-unquoting bare paths corrupts
    # literal apostrophes. These are compatibility controls, not read receipts.
    def test_legacy_claude_read_and_bare_declarations(self):
        self.artifacts("legacy session's artifacts")
        metadata = (
            f' raw bytes {len(self.raw)} visible bytes {len(self.raw)}'
            f' content SHA-256 {hashlib.sha256(self.raw).hexdigest()}'
        )
        declarations = (
            f'Required source segment 1/1: use Read to read {self.segment} in full' + metadata,
            f'Required source segment 1/1: {self.segment}' + metadata,
        )
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                self.assert_authorized(*self.permissions(declaration))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True, type=Path)
    args = parser.parse_args()
    library = args.runtime.resolve() / 'scripts' / 'lib'
    sys.path.insert(0, str(library))
    spec = importlib.util.spec_from_file_location('required_source_audit', library / 'review-read-audit.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('cannot load runtime auditor')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    RequiredSourceQuotesTests.audit = module
    unittest.main(argv=[sys.argv[0]], verbosity=2)


if __name__ == '__main__':
    main()
