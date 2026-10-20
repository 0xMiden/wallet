# test_ledger.py
import contextlib, io, json, os, tempfile, time, unittest
import ledger

ME = 'wi-test'

class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'ledger.json')

    def test_missing_file_is_empty(self):
        self.assertEqual(ledger.load(self.path), {})

    def test_corrupt_file_raises_with_path(self):
        with open(self.path, 'w') as f:
            f.write('{"1129": {"state": ')
        with self.assertRaises(ledger.LedgerError) as ctx:
            ledger.load(self.path)
        self.assertIn(self.path, str(ctx.exception))

    def test_update_merges_and_persists(self):
        ledger.claim(self.path, 1129, ME)
        ledger.update(self.path, 1129, ME, branch='issue/1129-x')
        entry = ledger.update(self.path, 1129, ME, state='ci', pr=1130)
        self.assertEqual(entry['branch'], 'issue/1129-x')
        self.assertEqual(entry['pr'], 1130)
        self.assertEqual(ledger.load(self.path)['1129']['state'], 'ci')
        self.assertIn('updated', entry)

    def test_unknown_state_rejected_and_file_untouched(self):
        ledger.claim(self.path, 1, ME)
        with self.assertRaises(ledger.LedgerError):
            ledger.update(self.path, 1, ME, state='done')
        self.assertEqual(ledger.load(self.path)['1']['state'], 'claimed')

    def test_write_leaves_no_tmp_file(self):
        ledger.claim(self.path, 1, ME)
        self.assertEqual([f for f in os.listdir(self.dir) if f.startswith('.ledger-')], [])

    def test_cli_set_parses_ints(self):
        ledger.claim(self.path, 7, ME)
        with contextlib.redirect_stdout(io.StringIO()):
            ledger.main(['--path', self.path, '--owner', ME, 'set', '7', 'state=ci', 'pr=12', 'ci_attempts=2'])
        entry = ledger.load(self.path)['7']
        self.assertEqual((entry['pr'], entry['ci_attempts']), (12, 2))

    def test_cli_claim_records_fields_in_the_same_write(self):
        # A PR is claimed with kind=pr in one locked write, so a death right after claim never
        # leaves an entry the resume rules would read as an issue.
        with contextlib.redirect_stdout(io.StringIO()):
            ledger.main(['--path', self.path, '--owner', ME, 'claim', '1237', 'kind=pr', 'pr=1237'])
        entry = ledger.load(self.path)['1237']
        self.assertEqual((entry['kind'], entry['pr'], entry['state'], entry['owner']), ('pr', 1237, 'claimed', ME))

    def test_cli_claim_refuses_number_and_owner_fields(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.main(['--path', self.path, '--owner', ME, 'claim', '1237', 'owner=someone'])

class OtherRepoKeyTest(unittest.TestCase):
    """A web-sdk PR is keyed `web-sdk#N`, so it never collides with the wallet's issue or PR #N."""
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'ledger.json')
        self._alive = ledger.alive
        ledger.alive = lambda owner: owner == ME

    def tearDown(self):
        ledger.alive = self._alive

    def test_a_web_sdk_pr_and_a_wallet_issue_of_one_number_are_separate_entries(self):
        self.assertTrue(ledger.claim(self.path, 456, ME))
        self.assertTrue(ledger.claim(self.path, 'web-sdk#456', ME, kind='pr', pr=456))
        ledger.update(self.path, 'web-sdk#456', ME, state='reviewing')
        data = ledger.load(self.path)
        self.assertEqual((data['456']['state'], 'repo' in data['456']), ('claimed', False))
        sdk = data['web-sdk#456']
        self.assertEqual((sdk['number'], sdk['repo'], sdk['state']), (456, '0xMiden/web-sdk', 'reviewing'))

    def test_malformed_and_unknown_keys_are_refused(self):
        for bad in ('wallet#5', '#5', 'web-sdk#', 'web-sdk#x', 'x', '-1', '', 'web-sdk#5#6'):
            with self.assertRaises(ledger.LedgerError, msg=bad):
                ledger.claim(self.path, bad, ME)
        self.assertEqual(ledger.load(self.path), {})

    def test_reports_name_another_repositorys_entry_by_its_key(self):
        for key in ('web-sdk#7', 7, 'web-sdk#3'):
            ledger.claim(self.path, key, 'dead')
        self.assertEqual(ledger.adopt(self.path, ME), [7, 'web-sdk#3', 'web-sdk#7'])
        self.assertEqual([ledger.entry_key(e) for e in ledger.mine(self.path, ME)], [7, 'web-sdk#3', 'web-sdk#7'])
        ledger.release(self.path, 'web-sdk#3', ME, 'next: review')
        self.assertEqual([ledger.entry_key(e) for e in ledger.offered(self.path)], ['web-sdk#3'])

    def test_cli_takes_a_prefixed_key_and_refuses_setting_the_repo(self):
        with contextlib.redirect_stdout(io.StringIO()):
            ledger.main(['--path', self.path, '--owner', ME, 'claim', 'web-sdk#456', 'kind=pr', 'pr=456'])
            ledger.main(['--path', self.path, '--owner', ME, 'set', 'web-sdk#456', 'state=ci'])
        self.assertEqual(ledger.load(self.path)['web-sdk#456']['state'], 'ci')
        with self.assertRaises(ledger.LedgerError):
            ledger.main(['--path', self.path, '--owner', ME, 'set', 'web-sdk#456', 'repo=0xMiden/wallet'])


def _claim_worker(path, owner, out, number):
    # Every racer is a live session, so exactly one may win (macOS spawns workers: patch here).
    ledger.alive = lambda _owner: True
    # Hold the read-modify-write open long enough that, without the lock, every racer reads the
    # same unclaimed entry; with it the racers only queue.
    write = ledger._write
    ledger._write = lambda p, d: (time.sleep(0.02), write(p, d))
    out.put((owner, ledger.claim(path, number, owner)))


def _update_worker(path, number):
    ledger.claim(path, number, 'o%d' % number)
    ledger.update(path, number, 'o%d' % number, state='implementing')


class OwnerTest(unittest.TestCase):
    def test_this_process_is_alive_under_its_own_owner_name(self):
        self.assertTrue(ledger.alive(ledger.owner_for(os.getpid())))

    def test_missing_pid_is_dead(self):
        self.assertFalse(ledger.alive('wi-99999999@0'))

    def test_reused_pid_with_other_start_is_dead(self):
        pid = os.getpid()
        self.assertFalse(ledger.alive('wi-%d@1' % pid))

    def test_malformed_owner_is_dead(self):
        self.assertFalse(ledger.alive('wi-abc'))


class MultiSessionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'ledger.json')
        self.live = {'a', 'b'}
        self._alive = ledger.alive
        ledger.alive = lambda owner: owner in self.live

    def tearDown(self):
        ledger.alive = self._alive

    def test_claim_is_exclusive_while_owner_lives(self):
        self.assertTrue(ledger.claim(self.path, 1, 'a'))
        self.assertFalse(ledger.claim(self.path, 1, 'b'))
        self.assertTrue(ledger.claim(self.path, 1, 'a'))
        self.assertEqual(ledger.load(self.path)['1']['owner'], 'a')

    def test_dead_owners_active_claim_is_adopted_as_is(self):
        ledger.claim(self.path, 1, 'a')
        ledger.update(self.path, 1, 'a', state='ci', pr=9)
        self.live.discard('a')
        self.assertTrue(ledger.claim(self.path, 1, 'b'))
        entry = ledger.load(self.path)['1']
        self.assertEqual((entry['owner'], entry['state'], entry['pr']), ('b', 'ci', 9))

    def test_finished_entry_is_never_reclaimed(self):
        ledger.claim(self.path, 1, 'a')
        ledger.update(self.path, 1, 'a', state='merged')
        self.assertFalse(ledger.claim(self.path, 1, 'a'))

    def test_needs_definition_entry_reopens_on_claim(self):
        ledger.claim(self.path, 1, 'a')
        ledger.update(self.path, 1, 'a', state='needs-definition')
        self.assertTrue(ledger.claim(self.path, 1, 'b'))
        entry = ledger.load(self.path)['1']
        self.assertEqual((entry['owner'], entry['state']), ('b', 'claimed'))

    def test_update_refuses_another_owner(self):
        ledger.claim(self.path, 1, 'a')
        with self.assertRaises(ledger.LedgerError):
            ledger.update(self.path, 1, 'b', state='ci')
        self.assertEqual(ledger.load(self.path)['1']['state'], 'claimed')

    def test_update_refuses_an_unclaimed_issue(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.update(self.path, 5, 'a', state='ci')

    def test_adopt_takes_only_dead_owners_active_entries(self):
        for n, owner, state in ((1, 'a', 'ci'), (2, 'c', 'reviewing'), (3, 'c', 'merged'), (4, 'c', 'deferred')):
            self.live.add(owner)
            ledger.claim(self.path, n, owner)
            ledger.update(self.path, n, owner, state=state)
        self.live.discard('c')
        self.assertEqual(ledger.adopt(self.path, 'b'), [2, 4])
        data = ledger.load(self.path)
        self.assertEqual([data[k]['owner'] for k in ('1', '2', '3', '4')], ['a', 'b', 'c', 'b'])

    def test_release_hands_an_active_entry_to_the_next_claimer_as_it_stands(self):
        ledger.claim(self.path, 1, 'a')
        ledger.update(self.path, 1, 'a', state='reviewing', branch='issue/1-x')
        ledger.release(self.path, 1, 'a', handoff='r3 fix plan gated; next: fixer')
        self.assertEqual(ledger.mine(self.path, 'a'), [])
        self.assertEqual([e['number'] for e in ledger.offered(self.path)], [1])
        self.assertTrue(ledger.claim(self.path, 1, 'b'))
        entry = ledger.load(self.path)['1']
        self.assertEqual((entry['owner'], entry['state'], entry['branch'], entry['handoff']),
                         ('b', 'reviewing', 'issue/1-x', 'r3 fix plan gated; next: fixer'))
        self.assertNotIn('released_by', entry)
        self.assertEqual(ledger.offered(self.path), [])

    def test_release_needs_the_owner_a_handoff_and_an_unfinished_entry(self):
        ledger.claim(self.path, 1, 'a')
        with self.assertRaises(ledger.LedgerError):
            ledger.release(self.path, 1, 'b', handoff='x')
        with self.assertRaises(ledger.LedgerError):
            ledger.release(self.path, 1, 'a', handoff='')
        ledger.update(self.path, 1, 'a', state='merged')
        with self.assertRaises(ledger.LedgerError):
            ledger.release(self.path, 1, 'a', handoff='x')
        with self.assertRaises(ledger.LedgerError):
            ledger.release(self.path, 2, 'a', handoff='x')
        self.assertEqual(ledger.load(self.path)['1']['owner'], 'a')

    def test_adopt_leaves_a_released_entry_for_a_claimer(self):
        # Every session runs adopt on each heartbeat; if it took released entries, the first heartbeat
        # would win them instead of the idle session that asked.
        ledger.claim(self.path, 1, 'a')
        ledger.release(self.path, 1, 'a', handoff='x')
        self.live.discard('a')
        self.assertEqual(ledger.adopt(self.path, 'b'), [])
        self.assertEqual(ledger.load(self.path)['1']['owner'], '')

    def test_load_counts_active_and_deferred_per_live_owner(self):
        for n, owner, state in ((1, 'a', 'implementing'), (2, 'a', 'reviewing'), (3, 'a', 'deferred'),
                                (4, 'a', 'merged'), (5, 'b', 'merged'), (6, 'c', 'ci')):
            self.live.add(owner)
            ledger.claim(self.path, n, owner)
            ledger.update(self.path, n, owner, state=state)
        ledger.claim(self.path, 7, 'b')
        ledger.release(self.path, 7, 'b', handoff='x')
        self.live.discard('c')
        counts = {o: (v['active'], v['deferred']) for o, v in ledger.session_load(self.path).items()}
        self.assertEqual(counts, {'a': (2, 1), 'b': (0, 0)})

    def test_mine_lists_own_unfinished_entries(self):
        ledger.claim(self.path, 1, 'a')
        ledger.claim(self.path, 2, 'a')
        ledger.update(self.path, 2, 'a', state='merged')
        ledger.claim(self.path, 3, 'b')
        self.assertEqual([e['number'] for e in ledger.mine(self.path, 'a')], [1])

    def test_concurrent_claims_have_one_winner(self):
        import multiprocessing
        for number in range(42, 47):
            out = multiprocessing.Queue()
            procs = [multiprocessing.Process(target=_claim_worker, args=(self.path, 'o%d' % i, out, number))
                     for i in range(16)]
            for p in procs:
                p.start()
            for p in procs:
                p.join(timeout=20)
            results = [out.get(timeout=10) for _ in procs]
            winners = [o for o, won in results if won]
            self.assertEqual(len(winners), 1, 'issue %d: %s' % (number, winners))
            self.assertEqual(ledger.load(self.path)[str(number)]['owner'], winners[0])

    def test_concurrent_updates_keep_every_entry(self):
        import multiprocessing
        ledger.alive = self._alive
        procs = [multiprocessing.Process(target=_update_worker, args=(self.path, n)) for n in range(12)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=20)
        data = ledger.load(self.path)
        self.assertEqual(sorted(int(k) for k in data), list(range(12)))
        self.assertTrue(all(e['state'] == 'implementing' for e in data.values()))


if __name__ == '__main__':
    unittest.main()
