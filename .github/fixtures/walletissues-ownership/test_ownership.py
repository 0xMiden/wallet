import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import ledger


ME = 'wi-owner-one'
OTHER = 'wi-other-live'
REAL_RUN = subprocess.run
ACTIVE = ('implementing', 'reviewing', 'ci')


class PublicOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'ledger.json')
        self.responses = {}
        self.calls = []
        self.transport = mock.patch.object(ledger.subprocess, 'run', side_effect=self.github)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.liveness = mock.patch.object(ledger, 'alive', side_effect=lambda owner: owner in {ME, OTHER})
        self.liveness.start()
        self.addCleanup(self.liveness.stop)

    def github(self, command, **options):
        self.assertEqual(command[:4], ['gh', 'api', '--method', 'GET'])
        self.assertTrue(command[4].startswith('repos/0xMiden/wallet/issues/'))
        self.assertEqual(len(command), 5)
        self.assertTrue(options['check'])
        self.assertTrue(options['capture_output'])
        self.assertTrue(options['text'])
        self.assertGreater(options['timeout'], 0)
        self.assertLessEqual(options['timeout'], 30)
        number = int(command[4].rsplit('/', 1)[1])
        self.calls.append(number)
        response = self.responses.get(number, self.issue(number))
        if isinstance(response, Exception):
            raise response
        text = response if isinstance(response, str) else json.dumps(response)
        return subprocess.CompletedProcess(command, 0, stdout=text, stderr='')

    @staticmethod
    def issue(number, assignees=('co-owner', 'WiktorStarczewski'), state='open'):
        return {'number': number, 'state': state, 'assignees': [{'login': login} for login in assignees]}

    def bytes(self):
        if not os.path.exists(self.path):
            return None
        with open(self.path, 'rb') as source:
            return source.read()

    def active(self, number, state='implementing', owner=ME, **fields):
        ledger.claim(self.path, number, owner, **fields)
        ledger.update(self.path, number, owner, state=state)

    def assert_refused_unchanged(self, operation):
        before = self.bytes()
        with self.assertRaises(ledger.LedgerError) as failure:
            operation()
        self.assertEqual(self.bytes(), before)
        self.assertIn('ownership', str(failure.exception).lower())
        self.assertIn('WiktorStarczewski', str(failure.exception))
        self.assertIn('gh issue view', str(failure.exception))
        return str(failure.exception)

    def audit_cli(self):
        try:
            return ledger.main(['--path', self.path, '--owner', ME, 'ownership-audit'])
        except SystemExit as error:
            self.fail('ownership-audit must be available, got parser exit %s' % error.code)

    def test_each_active_transition_requires_actual_public_assignment(self):
        for number, state in enumerate(ACTIVE, 1):
            with self.subTest(state=state):
                ledger.claim(self.path, number, ME)
                self.responses[number] = self.issue(number, ('co-owner',))
                self.assert_refused_unchanged(lambda: ledger.update(self.path, number, ME, state=state))
                self.assertEqual(ledger.load(self.path)[str(number)]['state'], 'claimed')
        self.assertEqual(self.calls, [1, 2, 3])

    def test_assigned_open_issue_can_progress_and_keeps_every_coassignee(self):
        original = self.issue(7)
        self.responses[7] = original
        ledger.claim(self.path, 7, ME)
        for state in ACTIVE:
            entry = ledger.update(self.path, 7, ME, state=state)
            self.assertEqual((entry['state'], entry['owner']), (state, ME))
        self.assertEqual(original, self.issue(7))
        self.assertEqual(ledger.load(self.path)['7']['state'], 'ci')

    def test_direct_active_claim_does_not_bypass_assignment_or_create_a_row(self):
        for number, state in enumerate(ACTIVE, 11):
            with self.subTest(state=state):
                self.responses[number] = self.issue(number, ())
                self.assert_refused_unchanged(lambda: ledger.claim(self.path, number, ME, state=state))
                self.assertNotIn(str(number), ledger.load(self.path))

    def test_active_metadata_update_rechecks_later_public_unassignment(self):
        self.active(8, 'ci')
        self.responses[8] = self.issue(8, ())
        self.assert_refused_unchanged(lambda: ledger.update(self.path, 8, ME, pushed='new-head'))
        self.assertNotIn('pushed', ledger.load(self.path)['8'])

    def test_closed_pr_wrong_identity_or_malformed_lookup_never_grants_active_state(self):
        invalid = [
            self.issue(19, state='closed'),
            {**self.issue(19), 'pull_request': {}},
            self.issue(20),
            {**self.issue(19), 'number': True},
            {**self.issue(19), 'state': 'unknown'},
            {**self.issue(19), 'assignees': None},
            {**self.issue(19), 'assignees': [{'login': 'WiktorStarczewski'}, {}]},
            {**self.issue(19), 'assignees': [{'login': ''}]},
            {'number': 19, 'state': 'open'},
            [],
            'not JSON',
            subprocess.CalledProcessError(1, ['gh'], stderr='PRIVATE-LOOKUP-DETAIL'),
            subprocess.TimeoutExpired(['gh'], 20, stderr='PRIVATE-LOOKUP-DETAIL'),
            FileNotFoundError('PRIVATE-LOOKUP-DETAIL'),
        ]
        ledger.claim(self.path, 19, ME)
        for response in invalid:
            with self.subTest(response_type=type(response).__name__, response=repr(response)[:90]):
                self.responses[19] = response
                error = self.assert_refused_unchanged(lambda: ledger.update(self.path, 19, ME, state='reviewing'))
                self.assertNotIn('PRIVATE-LOOKUP-DETAIL', error)

    def test_pr_other_repository_other_owner_and_nonactive_states_do_not_lookup(self):
        for number, state in enumerate(('claimed', 'deferred', 'merged', 'parked', 'skipped', 'needs-definition'), 30):
            ledger.claim(self.path, number, ME)
            ledger.update(self.path, number, ME, state=state)
        ledger.claim(self.path, 40, ME, kind='pr', pr=40)
        ledger.update(self.path, 40, ME, state='reviewing')
        ledger.claim(self.path, 'web-sdk#40', ME, kind='pr', pr=40)
        ledger.update(self.path, 'web-sdk#40', ME, state='ci')
        ledger.claim(self.path, 41, OTHER)
        with self.assertRaisesRegex(ledger.LedgerError, 'belongs to'):
            ledger.update(self.path, 41, ME, state='implementing')
        self.assertFalse(ledger.claim(self.path, 41, ME, state='implementing'))
        self.assertEqual(self.calls, [])

    def test_safe_defer_or_terminal_exit_remains_available_after_public_assignment_is_lost(self):
        for number, state in enumerate(('deferred', 'merged', 'parked', 'skipped', 'needs-definition'), 45):
            self.active(number)
            self.responses[number] = self.issue(number, ())
            self.calls.clear()
            self.assertEqual(ledger.update(self.path, number, ME, state=state)['state'], state)
            self.assertEqual(self.calls, [])

    def test_claim_revalidates_both_dead_and_released_active_entries(self):
        self.active(60, 'reviewing', owner='dead-owner')
        self.responses[60] = self.issue(60, ())
        self.assert_refused_unchanged(lambda: ledger.claim(self.path, 60, ME))
        self.assertEqual(ledger.load(self.path)['60']['owner'], 'dead-owner')
        self.active(61, 'ci')
        ledger.release(self.path, 61, ME, 'reviewed branch awaits CI')
        self.responses[61] = self.issue(61, ())
        self.assert_refused_unchanged(lambda: ledger.claim(self.path, 61, ME))
        self.assertEqual(ledger.load(self.path)['61']['owner'], '')

    def test_adopt_checks_active_wallet_issues_before_any_atomic_owner_write(self):
        self.active(70, 'reviewing', owner='dead-owner')
        self.active(71, 'ci', owner='dead-owner')
        ledger.claim(self.path, 72, 'dead-owner', kind='pr', pr=72, state='reviewing')
        ledger.claim(self.path, 'web-sdk#73', 'dead-owner', kind='pr', pr=73, state='ci')
        ledger.claim(self.path, 74, 'dead-owner', state='deferred')
        self.responses[71] = self.issue(71, ())
        self.assert_refused_unchanged(lambda: ledger.adopt(self.path, ME))
        self.assertTrue(all(entry['owner'] == 'dead-owner' for entry in ledger.load(self.path).values()))
        self.responses[71] = self.issue(71)
        self.calls.clear()
        self.assertEqual(ledger.adopt(self.path, ME), [70, 71, 72, 74, 'web-sdk#73'])
        self.assertEqual(self.calls, [70, 71])

    def test_audit_reports_each_owned_active_issue_failure_and_never_writes(self):
        self.active(80)
        self.active(81, 'reviewing')
        self.active(82, 'ci')
        self.active(83, owner=OTHER)
        ledger.claim(self.path, 84, ME, kind='pr', pr=84, state='reviewing')
        ledger.claim(self.path, 'web-sdk#85', ME, kind='pr', pr=85, state='ci')
        ledger.claim(self.path, 86, ME, state='claimed')
        ledger.claim(self.path, 87, ME, state='deferred')
        self.responses[81] = self.issue(81, ())
        self.responses[82] = subprocess.TimeoutExpired(['gh'], 20)
        before = self.bytes()
        self.calls.clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.audit_cli()
        self.assertEqual(code, 2)
        self.assertEqual(self.bytes(), before)
        result = json.loads(out.getvalue())
        self.assertEqual((result['owner'], result['checked']), (ME, [80, 81, 82]))
        self.assertEqual([failure['number'] for failure in result['failures']], [81, 82])
        self.assertEqual(self.calls, [80, 81, 82])
        for failure in result['failures']:
            self.assertIn('WiktorStarczewski', failure['error'])

    def test_audit_clean_and_empty_results_are_read_only_successes(self):
        for seeded in (False, True):
            with self.subTest(seeded=seeded):
                if seeded:
                    self.active(90)
                before = self.bytes()
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    code = self.audit_cli()
                self.assertEqual(code, 0)
                self.assertEqual(self.bytes(), before)
                result = json.loads(out.getvalue())
                self.assertEqual(result['checked'], [90] if seeded else [])
                self.assertEqual(result['failures'], [])

    def test_existing_kind_and_repo_cannot_be_changed_to_bypass_the_guard(self):
        ledger.claim(self.path, 95, ME)
        for fields in ({'kind': 'pr'}, {'kind': 'other'}, {'repo': '0xMiden/web-sdk'}):
            for operation in (ledger.update, ledger.claim):
                with self.subTest(operation=operation.__name__, fields=fields):
                    before = self.bytes()
                    with self.assertRaisesRegex(ledger.LedgerError, 'kind|repo'):
                        operation(self.path, 95, ME, state='implementing', **fields)
                    self.assertEqual(self.bytes(), before)
        ledger.claim(self.path, 96, ME, kind='pr', pr=96)
        before = self.bytes()
        with self.assertRaisesRegex(ledger.LedgerError, 'kind'):
            ledger.update(self.path, 96, ME, kind='issue', state='reviewing')
        self.assertEqual(self.bytes(), before)
        self.assertEqual(self.calls, [])

    def test_direct_claim_cannot_override_repository_identity(self):
        for key, repo in ((97, '0xMiden/web-sdk'), ('web-sdk#97', '0xMiden/wallet')):
            with self.subTest(key=key):
                before = self.bytes()
                with self.assertRaisesRegex(ledger.LedgerError, 'repo'):
                    ledger.claim(self.path, key, ME, repo=repo, state='ci')
                self.assertEqual(self.bytes(), before)
        self.assertEqual(self.calls, [])

    def test_mine_refuses_to_resume_an_unassigned_active_issue_but_show_still_works(self):
        self.active(98, 'ci')
        self.responses[98] = self.issue(98, ())
        self.assert_refused_unchanged(lambda: ledger.mine(self.path, ME))
        self.assertEqual(ledger.load(self.path)['98']['state'], 'ci')
        out = io.StringIO()
        self.calls.clear()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ledger.main(['--path', self.path, 'show']), 0)
        self.assertEqual(json.loads(out.getvalue())['98']['state'], 'ci')
        self.assertEqual(self.calls, [])

    def test_real_cli_audit_exit_and_output_preserve_the_ledger_and_coassignees(self):
        self.active(100, 'ci')
        bin_dir = os.path.join(self.directory.name, 'bin')
        os.mkdir(bin_dir)
        shim = os.path.join(bin_dir, 'gh')
        with open(shim, 'w') as script:
            script.write('#!' + sys.executable + '\n')
            script.write('import json, os, sys\n')
            script.write("assert sys.argv[1:] == ['api', '--method', 'GET', 'repos/0xMiden/wallet/issues/100']\n")
            script.write("print(os.environ['OWNERSHIP_TEST_REPLY'])\n")
        os.chmod(shim, 0o700)
        before = self.bytes()
        for assigned in (False, True):
            with self.subTest(assigned=assigned):
                assignees = ('co-owner', 'WiktorStarczewski') if assigned else ('co-owner',)
                payload = self.issue(100, assignees)
                environment = {**os.environ, 'PATH': bin_dir + os.pathsep + os.environ['PATH'],
                               'OWNERSHIP_TEST_REPLY': json.dumps(payload)}
                result = REAL_RUN([sys.executable, '-B', ledger.__file__, '--path', self.path,
                                   '--owner', ME, 'ownership-audit'], capture_output=True, text=True,
                                  env=environment, timeout=10)
                self.assertEqual(result.returncode, 0 if assigned else 2, result.stderr)
                self.assertEqual(self.bytes(), before)
                self.assertTrue(result.stdout.startswith('{'), result.stderr)
                audit = json.loads(result.stdout)
                self.assertEqual(audit['checked'], [100])
                self.assertEqual(len(audit['failures']), 0 if assigned else 1)
                self.assertEqual(payload['assignees'], [{'login': login} for login in assignees])

    def test_invalid_direct_claim_state_cannot_poison_resume(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'unknown state'):
            ledger.claim(self.path, 99, ME, state='not-a-state')
        self.assertEqual(ledger.load(self.path), {})


if __name__ == '__main__':
    unittest.main()
