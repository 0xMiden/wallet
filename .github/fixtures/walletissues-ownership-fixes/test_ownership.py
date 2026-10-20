import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import traceback
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
        self.command_attempts = []
        self.cli_trace_observations = []
        self.transport = mock.patch.object(ledger.subprocess, 'run', side_effect=self.github)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.liveness = mock.patch.object(ledger, 'alive', side_effect=lambda owner: owner in {ME, OTHER})
        self.liveness.start()
        self.addCleanup(self.liveness.stop)

    def github(self, command, **options):
        self.command_attempts.append(list(command))
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
        self.assertEqual(self.command_attempts, [
            ['gh', 'api', '--method', 'GET', 'repos/0xMiden/wallet/issues/7']
        ] * 3)
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
            script.write("with open(os.environ['OWNERSHIP_TEST_COMMANDS'], 'a') as trace:\n")
            script.write("    trace.write(json.dumps(sys.argv[1:]) + '\\n')\n")
            script.write("if sys.argv[1:] != ['api', '--method', 'GET', 'repos/0xMiden/wallet/issues/100']:\n")
            script.write("    raise SystemExit(17)\n")
            script.write("print(os.environ['OWNERSHIP_TEST_REPLY'])\n")
        os.chmod(shim, 0o700)
        trace_path = os.path.join(self.directory.name, 'gh-attempts.jsonl')
        before = self.bytes()
        for assigned in (False, True):
            with self.subTest(assigned=assigned):
                assignees = ('co-owner', 'WiktorStarczewski') if assigned else ('co-owner',)
                payload = self.issue(100, assignees)
                Path(trace_path).write_text('')
                environment = {**os.environ, 'PATH': bin_dir + os.pathsep + os.environ['PATH'],
                               'OWNERSHIP_TEST_REPLY': json.dumps(payload),
                               'OWNERSHIP_TEST_COMMANDS': trace_path}
                result = REAL_RUN([sys.executable, '-B', ledger.__file__, '--path', self.path,
                                   '--owner', ME, 'ownership-audit'], capture_output=True, text=True,
                                  env=environment, timeout=10)
                attempts = [json.loads(line) for line in Path(trace_path).read_text().splitlines()]
                self.cli_trace_observations.append({'assigned': assigned, 'attempts': attempts,
                                                    'returncode': result.returncode,
                                                    'stdout': result.stdout, 'stderr': result.stderr})
                self.assertEqual(result.returncode, 0 if assigned else 2, result.stderr)
                self.assertEqual(self.bytes(), before)
                self.assertTrue(result.stdout.startswith('{'), result.stderr)
                audit = json.loads(result.stdout)
                self.assertEqual(audit['checked'], [100])
                self.assertEqual(len(audit['failures']), 0 if assigned else 1)
                self.assertEqual(attempts, [
                    ['api', '--method', 'GET', 'repos/0xMiden/wallet/issues/100']
                ])

    def test_invalid_direct_claim_state_cannot_poison_resume(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'unknown state'):
            ledger.claim(self.path, 99, ME, state='not-a-state')
        self.assertEqual(ledger.load(self.path), {})


class RunnerImportTest(unittest.TestCase):
    def test_import_without_ci_environment_has_no_execution_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in os.environ.items()
                           if key not in {'OWNERSHIP_RESULTS', 'GITHUB_SHA', 'GITHUB_RUN_ID'}}
            source = Path(__file__).resolve().parent
            code = (
                "import sys, subprocess, tempfile, unittest\n"
                "from pathlib import Path\n"
                "from unittest import mock\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "def refuse(*args, **kwargs):\n"
                "    raise AssertionError('runner import performed an operation')\n"
                "with mock.patch.object(subprocess, 'run', side_effect=refuse), "
                "mock.patch.object(tempfile, 'TemporaryDirectory', side_effect=refuse), "
                "mock.patch.object(Path, 'mkdir', side_effect=refuse), "
                "mock.patch.object(Path, 'write_text', side_effect=refuse), "
                "mock.patch.object(unittest.TextTestRunner, 'run', side_effect=refuse):\n"
                "    import run_tests\n"
            )
            result = REAL_RUN([sys.executable, '-B', '-c', code, str(source)], cwd=directory,
                              env=environment, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
            self.assertEqual(result.stderr, '')
            self.assertEqual(list(Path(directory).iterdir()), [])


class HeartbeatAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.root = self.home / '.local/state/wallet-handoff/2026-10-19'
        self.root.mkdir(parents=True)
        (self.root / 'owner').write_text(ME + '\n')
        self.ledger_path = self.home / '.local/state/walletissues/ledger.json'
        self.ledger_path.parent.mkdir(parents=True)
        self.ledger_path.write_text(json.dumps({
            '200': {'number': 200, 'state': 'ci', 'owner': ME},
            '201': {'number': 201, 'state': 'claimed', 'owner': 'dead-owner'}
        }, sort_keys=True) + '\n')
        self.observations = []
        ledger_path = str(self.home / '.claude/skills/walletissues/ledger.py')
        self.commands = [
            ('walletissues_ownership_audit', ['python3', '-B', ledger_path, '--owner', ME, 'ownership-audit']),
            ('walletissues_adopt', ['python3', '-B', ledger_path, '--owner', ME, 'adopt']),
            ('walletissues_load', ['python3', '-B', ledger_path, 'load']),
            ('walletissues_mine', ['python3', '-B', ledger_path, '--owner', ME, 'mine']),
            ('walletissues_offered', ['python3', '-B', ledger_path, 'offered']),
            ('walletissues_discovery', ['python3', '-B', str(self.home / '.claude/skills/walletissues/discover.py'), '--prs']),
            ('walletissues_status', ['python3', '-B', str(self.home / '.claude/skills/walletissues/status.py')]),
            ('walletsentry_status', ['python3', '-B', str(self.home / '.agents/skills/walletsentry/scripts/status.py')]),
            ('walletsentry_discovery', ['python3', '-B', str(self.home / '.agents/skills/walletsentry/scripts/discover.py')])
        ]
        self.retained = [name for name, _ in self.commands
                         if name not in {'walletissues_ownership_audit', 'walletissues_adopt', 'walletissues_mine'}]

    def tick(self, audit):
        calls = []
        before = self.ledger_path.read_bytes()

        def dispatch(command, **options):
            calls.append(list(command))
            names = [name for name, expected in self.commands if command == expected]
            self.assertEqual(len(names), 1, command)
            self.assertEqual(options, {'capture_output': True, 'text': True, 'timeout': 100})
            name = names[0]
            if name == 'walletissues_ownership_audit':
                if audit == 'timeout':
                    raise subprocess.TimeoutExpired(command, 100)
                if audit == 'oserror':
                    raise OSError('private audit executable unavailable')
                failures = [] if audit == 'success' else [
                    {'number': 200, 'error': 'public ownership requires OPEN and assignee WiktorStarczewski'}]
                return subprocess.CompletedProcess(command, 0 if not failures else 2,
                    stdout=json.dumps({'owner': ME, 'checked': [200], 'failures': failures}), stderr='')
            if name == 'walletissues_adopt':
                data = json.loads(self.ledger_path.read_text())
                data['201']['owner'] = ME
                self.ledger_path.write_text(json.dumps(data, sort_keys=True) + '\n')
                output = '[201]'
            elif name == 'walletissues_mine':
                output = json.dumps([row for row in json.loads(self.ledger_path.read_text()).values()
                                     if row['owner'] == ME])
            elif name == 'walletissues_load':
                output = self.ledger_path.read_text()
            else:
                output = '[]'
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')

        console = io.StringIO()
        exception = None
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch.object(subprocess, 'run', side_effect=dispatch), \
                contextlib.redirect_stdout(console):
            try:
                runpy.run_path(str(Path(__file__).resolve().parent / 'controller/heartbeat.py'),
                               run_name='ownership_private_heartbeat')
            except Exception as error:
                exception = {'type': type(error).__name__, 'message': str(error),
                             'traceback': traceback.format_exc()}
        names = [name for command in calls for name, expected in self.commands if command == expected]
        state_path = self.root / 'heartbeat.json'
        history_path = self.root / 'heartbeat-history.jsonl'
        outcome = {'audit': audit, 'calls': calls, 'names': names, 'console': console.getvalue(),
                   'exception': exception,
                   'ledger_before': before.decode(), 'ledger_after': self.ledger_path.read_text(),
                   'state': json.loads(state_path.read_text()) if state_path.exists() else None,
                   'history': [json.loads(line) for line in history_path.read_text().splitlines()]
                              if history_path.exists() else []}
        self.observations.append(outcome)
        destination = os.environ.get('OWNERSHIP_RESULTS')
        if destination:
            (Path(destination) / (self.id().rsplit('.', 1)[1] + '.observations.json')).write_text(
                json.dumps(self.observations, indent=2) + '\n')
        return outcome

    def assert_blocked(self, outcome, audit_code):
        self.assertEqual([name for name in outcome['names']
                          if name in {'walletissues_adopt', 'walletissues_mine'}], [], outcome)
        self.assertEqual(outcome['exception'], None, outcome)
        self.assertEqual(outcome['ledger_before'], outcome['ledger_after'])
        self.assertEqual(json.loads(outcome['ledger_after'])['201']['owner'], 'dead-owner')
        self.assertEqual(outcome['names'], ['walletissues_ownership_audit'] + self.retained)
        state = outcome['state']
        self.assertIsNotNone(state, outcome)
        observed_code = state['results']['walletissues_ownership_audit']['exit_code']
        if audit_code is None:
            self.assertNotEqual(observed_code, 0)
        else:
            self.assertEqual(observed_code, audit_code)
        for name in ('walletissues_adopt', 'walletissues_mine'):
            result = state['results'][name]
            self.assertNotEqual(result['exit_code'], 0)
            self.assertTrue(result.get('skipped'), result)
            self.assertNotEqual(outcome['history'][-1]['exit_codes'][name], 0)
        self.assertEqual(list(state['results']), [name for name, _ in self.commands])
        self.assertTrue(any(json.loads(line).get('kind') == 'heartbeat_complete'
                            for line in outcome['console'].splitlines()))

    def test_failed_or_timed_out_audit_skips_adopt_and_mine(self):
        for audit, code in [('failed', 2), ('timeout', 124)]:
            with self.subTest(audit=audit):
                self.assert_blocked(self.tick(audit), code)

    def test_audit_oserror_retains_diagnostics_and_blocks_resume(self):
        outcome = self.tick('oserror')
        self.assertEqual([name for name in outcome['names'] if name in self.retained],
                         self.retained, outcome)
        self.assert_blocked(outcome, None)

    def test_successful_audit_retains_the_original_command_sequence(self):
        outcome = self.tick('success')
        self.assertEqual(outcome['exception'], None, outcome)
        self.assertEqual(outcome['names'], [name for name, _ in self.commands])
        self.assertEqual(json.loads(outcome['ledger_after'])['201']['owner'], ME)
        self.assertEqual([row['exit_code'] for row in outcome['state']['results'].values()], [0] * 9)
        self.assertEqual(list(outcome['state']['results']), [name for name, _ in self.commands])
        self.assertEqual(len(outcome['history']), 1)

    def test_later_successful_audit_restores_admission_after_a_failed_tick(self):
        failed = self.tick('failed')
        outcome = self.tick('success')
        self.assertEqual(outcome['exception'], None, outcome)
        self.assertEqual(outcome['names'], [name for name, _ in self.commands])
        self.assertEqual(json.loads(outcome['ledger_after'])['201']['owner'], ME)
        self.assertEqual(len(outcome['history']), 2)
        self.assertEqual(outcome['history'][-1]['exit_codes']['walletissues_adopt'], 0)
        self.assertEqual(outcome['history'][-1]['exit_codes']['walletissues_mine'], 0)
        self.assertEqual(failed['state']['results']['walletissues_ownership_audit']['exit_code'], 2)


if __name__ == '__main__':
    unittest.main()
