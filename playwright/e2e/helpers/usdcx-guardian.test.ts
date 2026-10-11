/**
 * @jest-environment node
 */
import type { BridgedSendRow } from './bridge';
import {
  assertNoGuardianOpInFlight,
  burnFailureMessage,
  guardianFailureContext,
  guardianIdentity,
  type GuardianIdentity
} from './usdcx-guardian';

const HOSTED_GUARDIAN = 'https://guardian.openzeppelin.com';
// The hosted Guardian's answers on 2026-10-10.
const STATUS = {
  status: 'ok',
  version: '0.18.0',
  git_commit: 'fab5f5cb2c3f',
  environment: 'testnet',
  started_at: '2026-10-06T18:47:55.136361639+00:00',
  uptime_seconds: 351836
};
const PUBKEY = {
  commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
  pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
};

function stubFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return async input => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  };
}

const IDENTITY: GuardianIdentity = {
  url: HOSTED_GUARDIAN,
  version: '0.18.0',
  gitCommit: 'fab5f5cb2c3f',
  environment: 'testnet',
  commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
  pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
};

describe('guardianIdentity', () => {
  it('records /status and the ECDSA key from /pubkey', async () => {
    const calls: string[] = [];
    const identity = await guardianIdentity(
      HOSTED_GUARDIAN,
      stubFetch({ [`${HOSTED_GUARDIAN}/status`]: STATUS, [`${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]: PUBKEY }, calls)
    );
    expect(identity).toEqual(IDENTITY);
    expect(calls).toEqual([`${HOSTED_GUARDIAN}/status`, `${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]);
  });

  it('refuses a Guardian whose status is not ok', async () => {
    await expect(
      guardianIdentity(HOSTED_GUARDIAN, stubFetch({ [`${HOSTED_GUARDIAN}/status`]: { ...STATUS, status: 'degraded' } }))
    ).rejects.toThrow('status "degraded", not "ok"');
  });

  it('refuses a commitment that is not 32 bytes', async () => {
    await expect(
      guardianIdentity(
        HOSTED_GUARDIAN,
        stubFetch({
          [`${HOSTED_GUARDIAN}/status`]: STATUS,
          [`${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]: { ...PUBKEY, commitment: '0x6b3e' }
        })
      )
    ).rejects.toThrow('commitment 0x6b3e is not 64 hex');
  });

  it('names the URL of a failed request', async () => {
    await expect(guardianIdentity(HOSTED_GUARDIAN, stubFetch({}))).rejects.toThrow(
      `GET ${HOSTED_GUARDIAN}/status: HTTP 404`
    );
  });
});

describe('guardianFailureContext', () => {
  it('says unchanged when the re-read matches the identity recorded at the start', async () => {
    const context = await guardianFailureContext(IDENTITY, stubFetch({ [`${HOSTED_GUARDIAN}/status`]: STATUS }));
    expect(context).toContain(
      `Guardian ${HOSTED_GUARDIAN} (at start: version 0.18.0, git_commit fab5f5cb2c3f, environment testnet`
    );
    expect(context).toContain('re-read: unchanged');
  });

  it('shows both identities when the Guardian was redeployed mid-run', async () => {
    const context = await guardianFailureContext(
      IDENTITY,
      stubFetch({ [`${HOSTED_GUARDIAN}/status`]: { ...STATUS, version: '0.18.1', git_commit: '0123456789ab' } })
    );
    expect(context).toContain('version 0.18.0, git_commit fab5f5cb2c3f');
    expect(context).toContain('re-read DIFFERS: status ok, version 0.18.1, git_commit 0123456789ab');
  });

  it('never throws when the re-read fails', async () => {
    const context = await guardianFailureContext(IDENTITY, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(context).toContain('re-read failed: connect ECONNREFUSED');
  });
});

describe('assertNoGuardianOpInFlight', () => {
  const account = 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w';

  it("passes when none of the account's rows is Queued or Generating", () => {
    expect(() =>
      assertNoGuardianOpInFlight(
        [
          { id: 'c1', accountId: account, status: 2 },
          { id: 'u1', accountId: account, status: 4 },
          { id: 'o1', accountId: 'mtst1other_qr7qqq9wr6w', status: 0 }
        ],
        account
      )
    ).not.toThrow();
  });

  it("lists the account's Queued and Generating rows, matching a bare id to a composite one", () => {
    expect(() =>
      assertNoGuardianOpInFlight(
        [
          { id: 'q1', accountId: account, status: 0, type: 'consume' },
          { id: 'g1', accountId: account, status: 1, type: 'bridged-send' },
          { id: 'c1', accountId: account, status: 2 }
        ],
        'mtst1are0gtx635qs7starjk4m3x49vcm0w2g'
      )
    ).toThrow(/2 transaction\(s\)[\s\S]*q1 type=consume Queued[\s\S]*g1 type=bridged-send GeneratingTransaction/);
  });
});

describe('burnFailureMessage', () => {
  const row: BridgedSendRow = {
    id: 'b1',
    status: 3,
    stage: 'signing-proposal',
    stageTimestamps: { 'creating-proposal': 1, 'signing-proposal': 2 },
    error: 'Transaction failed',
    rawError: 'guardian: 409 Conflict: pending canonicalization',
    submitEvidence: [{ attemptId: 'a1', source: 'pin' }]
  };

  it('names the stage, both errors, the stage stamps and the submit evidence', () => {
    expect(burnFailureMessage(row)).toBe(
      [
        'USDCx burn row b1: status 3, stage signing-proposal',
        '  error: Transaction failed',
        '  rawError: guardian: 409 Conflict: pending canonicalization',
        '  stageTimestamps: {"creating-proposal":1,"signing-proposal":2}',
        '  submitEvidence: [{"attemptId":"a1","source":"pin"}]',
        '  the prior Guardian candidate had not settled'
      ].join('\n')
    );
  });

  it('adds the settle hint only for a 409 or a pending canonicalization', () => {
    expect(burnFailureMessage({ ...row, rawError: 'remote prover timed out' })).not.toContain('had not settled');
    expect(burnFailureMessage({ ...row, rawError: 'HTTP 409' })).toContain('had not settled');
  });
});
