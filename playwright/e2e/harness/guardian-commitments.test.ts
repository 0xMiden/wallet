/**
 * @jest-environment node
 */
import {
  createGuardianCommitmentLedger,
  guardianCommitmentReadOf,
  observeGuardianRead,
  waitForGuardianLedgerSettled,
  type ObservedResponse
} from './guardian-commitments';

const ORIGINS = { a: 'http://localhost:3000', b: 'http://localhost:3001' };
const ACCOUNT = '0x00aa';
const OTHER_ACCOUNT = '0x00bb';
const BEFORE = `0x${'1a'.repeat(32)}`;
const AFTER = `0x${'2b'.repeat(32)}`;
/** How the ledger reports an account id or commitment: lowercase, without 0x. */
const bare = (hex: string) => hex.slice(2).toLowerCase();

const pushAnswer = (commitment: string, accountId = ACCOUNT) => ({
  account_id: accountId,
  nonce: 3,
  new_commitment: commitment,
  ack_sig: '0x01'
});

const stateAnswer = (commitment: string, accountId = ACCOUNT) => ({
  account_id: accountId,
  commitment,
  state_json: {},
  created_at: '2026-09-15T00:00:00Z',
  updated_at: '2026-09-15T00:00:00Z'
});

describe('guardianCommitmentReadOf', () => {
  it.each([
    ['POST', 'http://localhost:3000/delta', 'push'],
    ['GET', `http://localhost:3000/state?account_id=${ACCOUNT}`, 'state'],
    ['GET', `http://localhost:3001/state?account_id=${ACCOUNT}`, 'state']
  ])('reads %s %s as a %s', (method, url, read) => {
    expect(guardianCommitmentReadOf(method, url, ORIGINS)).toBe(read);
  });

  it.each([
    ['POST', 'http://localhost:3000/delta/proposal'],
    ['PUT', 'http://localhost:3000/delta/proposal'],
    ['GET', `http://localhost:3000/delta?account_id=${ACCOUNT}&nonce=3`],
    ['GET', `http://localhost:3000/delta/since?account_id=${ACCOUNT}&nonce=2`],
    ['POST', 'http://localhost:3000/delta/candidate/abandon'],
    ['GET', 'http://localhost:3000/state/lookup?key_commitment=0x01'],
    ['POST', 'http://localhost:3000/state'],
    ['POST', 'http://localhost:3000/configure'],
    ['POST', 'http://localhost:57291/delta']
  ])('ignores %s %s', (method, url) => {
    expect(guardianCommitmentReadOf(method, url, ORIGINS)).toBeNull();
  });

  it('matches an operator configured with a trailing slash', () => {
    expect(guardianCommitmentReadOf('POST', 'https://guardian.example/delta', { a: 'https://guardian.example/' })).toBe(
      'push'
    );
  });
});

describe('guardian commitment ledger', () => {
  it('stays unsettled while the canonical state still names the commitment from before the push', () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('state', stateAnswer(BEFORE));
    ledger.record('push', pushAnswer(AFTER));
    ledger.record('state', stateAnswer(BEFORE));

    expect(ledger.unsettled()).toEqual([{ accountId: bare(ACCOUNT), pushed: bare(AFTER), canonical: bare(BEFORE) }]);
  });

  it('settles once a state read names the pushed commitment, whatever its case or prefix', () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', pushAnswer(AFTER));
    ledger.record('state', stateAnswer(bare(AFTER).toUpperCase()));

    expect(ledger.unsettled()).toEqual([]);
    expect(ledger.pushedAccounts()).toBe(1);
  });

  it('waits for the latest push, not the first', () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', pushAnswer(BEFORE));
    ledger.record('state', stateAnswer(BEFORE));
    ledger.record('push', pushAnswer(AFTER));

    expect(ledger.unsettled()).toEqual([{ accountId: bare(ACCOUNT), pushed: bare(AFTER), canonical: bare(BEFORE) }]);
  });

  it('keeps accounts apart', () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', pushAnswer(AFTER));
    ledger.record('push', pushAnswer(AFTER, OTHER_ACCOUNT));
    ledger.record('state', stateAnswer(AFTER));

    expect(ledger.unsettled()).toEqual([{ accountId: bare(OTHER_ACCOUNT), pushed: bare(AFTER), canonical: undefined }]);
  });

  it('ignores answers that name no account or no commitment', () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', { account_id: ACCOUNT, nonce: 3 });
    ledger.record('push', { new_commitment: AFTER });
    ledger.record('state', { account_id: ACCOUNT, commitment: '' });
    ledger.record('state', null);
    ledger.record('state', 'Internal error');

    expect(ledger.pushedAccounts()).toBe(0);
    expect(ledger.stateReads()).toBe(0);
    expect(ledger.unsettled()).toEqual([]);
  });
});

describe('observeGuardianRead', () => {
  const answer = (status: number, body: string): ObservedResponse => ({
    ok: () => status >= 200 && status < 300,
    text: async () => body
  });

  function fakeRoute(outcome: ObservedResponse | Error) {
    const calls: string[] = [];
    const delivered: ObservedResponse[] = [];
    const route = {
      async fetch({ timeout }: { timeout: number }) {
        calls.push(`fetch timeout=${timeout}`);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      async fulfill({ response }: { response: ObservedResponse }) {
        calls.push('fulfill');
        delivered.push(response);
      },
      async abort(errorCode?: string) {
        calls.push(`abort ${errorCode}`);
      }
    };
    return { route, calls, delivered };
  }

  it('records a successful answer and hands the wallet that same answer', async () => {
    const ledger = createGuardianCommitmentLedger();
    const response = answer(200, JSON.stringify(pushAnswer(AFTER)));
    const { route, calls, delivered } = fakeRoute(response);

    await observeGuardianRead(route, 'push', ledger);

    expect(calls).toEqual(['fetch timeout=0', 'fulfill']);
    expect(delivered[0]).toBe(response);
    expect(ledger.unsettled()).toEqual([{ accountId: bare(ACCOUNT), pushed: bare(AFTER), canonical: undefined }]);
  });

  it('records nothing from an error answer and still delivers it', async () => {
    const ledger = createGuardianCommitmentLedger();
    const { route, calls } = fakeRoute(answer(409, JSON.stringify(pushAnswer(AFTER))));

    await observeGuardianRead(route, 'push', ledger);

    expect(calls).toEqual(['fetch timeout=0', 'fulfill']);
    expect(ledger.pushedAccounts()).toBe(0);
  });

  it('delivers an unparseable body untouched', async () => {
    const ledger = createGuardianCommitmentLedger();
    const response = answer(200, '{');
    const { route, calls, delivered } = fakeRoute(response);

    await observeGuardianRead(route, 'state', ledger);

    expect(calls).toEqual(['fetch timeout=0', 'fulfill']);
    expect(delivered[0]).toBe(response);
    expect(ledger.stateReads()).toBe(0);
  });

  it('fails the request when it could not be sent', async () => {
    const ledger = createGuardianCommitmentLedger();
    const { route, calls } = fakeRoute(new Error('socket hang up'));

    await observeGuardianRead(route, 'state', ledger);

    expect(calls).toEqual(['fetch timeout=0', 'abort failed']);
  });
});

describe('waitForGuardianLedgerSettled', () => {
  /** Sleeps advance a fake clock, and `onSleep` lets a test change the ledger at a given moment. */
  function fakeClock(onSleep: (nowMs: number) => void = () => {}) {
    let nowMs = 0;
    return {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
        onSleep(nowMs);
      }
    };
  }

  it('resolves once the canonical state catches up with the last push', async () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', pushAnswer(AFTER));
    ledger.record('state', stateAnswer(BEFORE));
    const clock = fakeClock(nowMs => {
      if (nowMs === 4_000) ledger.record('state', stateAnswer(AFTER));
    });

    await expect(waitForGuardianLedgerSettled(ledger, { timeoutMs: 60_000, pollMs: 1_000, ...clock })).resolves.toBe(
      4_000
    );
  });

  it('fails at once when no push was observed', async () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('state', stateAnswer(BEFORE));
    const sleep = jest.fn(async () => {});

    await expect(waitForGuardianLedgerSettled(ledger, { timeoutMs: 60_000, now: () => 0, sleep })).rejects.toThrow(
      'no delta push was observed'
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('names the pushed and canonical commitments when the guardian never catches up', async () => {
    const ledger = createGuardianCommitmentLedger();
    ledger.record('push', pushAnswer(AFTER));
    ledger.record('state', stateAnswer(BEFORE));

    await expect(
      waitForGuardianLedgerSettled(ledger, { timeoutMs: 5_000, pollMs: 1_000, ...fakeClock() })
    ).rejects.toThrow(
      `after 5000ms (state reads observed: 1): account ${bare(ACCOUNT)} pushed ${bare(AFTER)}, canonical ${bare(BEFORE)}`
    );
  });
});
