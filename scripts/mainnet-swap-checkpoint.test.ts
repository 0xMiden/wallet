/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMainnetSwapCheckpoint,
  mainnetSwapNextAction,
  mainnetSwapRequestExpiresAt,
  matchAuthorizedSwap,
  saveMainnetSwapCheckpoint,
  swapProceeds,
  type MainnetSwapCheckpoint,
  type SwapOrderEvidence
} from '../playwright/e2e/helpers/mainnet-swap-checkpoint';

export function checkpoint(): MainnetSwapCheckpoint {
  return {
    version: 1,
    network: 'mainnet',
    account: 'mm1dedicatedaccount',
    sourceRunId: '123',
    phase: 'forward-authorized',
    createdAt: '2026-11-11T12:00:00.000Z',
    pricedAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
    offer: {
      faucetId: 'mm1a',
      hex: '0x' + '1'.repeat(30),
      symbol: 'USDCX',
      decimals: 6,
      balance: '10000000',
      usdMicros: '1000000'
    },
    request: {
      faucetId: 'mm1b',
      hex: '0x' + '2'.repeat(30),
      symbol: 'ETH',
      decimals: 8,
      balance: '123',
      usdMicros: '3000000000'
    },
    native: {
      faucetId: 'mm1a',
      hex: '0x' + '1'.repeat(30),
      symbol: 'USDCX',
      decimals: 6,
      balance: '10000000',
      usdMicros: '1000000'
    },
    baseFee: '1',
    principal: '1010000',
    forwardMinimum: '33649',
    reverseMinimum: '1007000',
    knownOrderIds: ['1'],
    feeBudget: '180',
    paidFees: '0'
  };
}
const row = (): SwapOrderEvidence => ({
  id: 'tx',
  orderId: '2',
  account: 'mm1dedicatedaccount',
  offeredFaucet: 'mm1a',
  requestedFaucet: 'mm1b',
  offer: '1010000',
  minimumReceive: '33649',
  initiatedAt: 1794398401
});

describe('durable nightly swap authorization', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swap-checkpoint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round trips the full authorization with private file permissions', () => {
    const path = join(dir, 'state', 'roundtrip.json');
    saveMainnetSwapCheckpoint(path, checkpoint());
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(checkpoint());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('key');
  });
  it('retains a reduced loss allowance in the immutable swap checkpoint', () => {
    const path = join(dir, 'roundtrip.json');
    const limited = { ...checkpoint(), lossBudgetUsdMicros: '1999500' };
    saveMainnetSwapCheckpoint(path, limited);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(limited);
  });
  it.each(['0', '-1', '2000001', '01999500', '1.5'])(
    'rejects an invalid retained loss allowance %s',
    lossBudgetUsdMicros => {
      const path = join(dir, 'roundtrip.json');
      writeFileSync(path, JSON.stringify({ ...checkpoint(), lossBudgetUsdMicros }));
      expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
    }
  );
  const withRequest = () => ({
    ...checkpoint(),
    forwardOrderId: '42',
    forwardRequestAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      noteId: `0x${'a'.repeat(64)}`,
      sha256: 'b'.repeat(64),
      canonicalSha256: 'c'.repeat(64),
      orderId: '42',
      minimumReceive: '33650',
      expiresAt: Date.parse(checkpoint().pricedAt) + 60_000
    }
  });
  it('durably binds the exact live PSWAP request, original deadline and actual reviewed minimum', () => {
    const state = withRequest();
    const path = join(dir, 'state.json');
    saveMainnetSwapCheckpoint(path, state);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(state);
    expect(mainnetSwapNextAction(state)).toBe('reconcile-forward');
  });
  it('preserves both distinct original SDK identities through return authorization', () => {
    const state = withRequest();
    state.phase = 'reverse-authorized';
    state.forwardReceived = '33650';
    state.returnAmount = '33650';
    state.returnBaseline = { offer: '8990000', request: '33773', native: '8989999' };
    const returned = {
      ...state,
      reverseOrderId: '43',
      reverseRequestAuthority: {
        ...state.forwardRequestAuthority,
        nonce: '22222222-2222-4222-8222-222222222222',
        orderId: '43',
        minimumReceive: '1007001'
      }
    };
    const path = join(dir, 'state.json');
    saveMainnetSwapCheckpoint(path, returned);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(returned);
  });
  const withGrantedReturn = () => {
    const state = withRequest();
    state.phase = 'reverse-authorized';
    state.forwardReceived = '33650';
    state.returnAmount = '33650';
    state.returnBaseline = { offer: '8990000', request: '33773', native: '8989999' };
    const grant = '2026-11-13T14:20:00.000Z';
    return {
      ...state,
      updatedAt: grant,
      recoveryReturnAuthorizedAt: grant,
      reverseOrderId: '43',
      reverseRequestAuthority: {
        ...state.forwardRequestAuthority,
        nonce: '22222222-2222-4222-8222-222222222222',
        orderId: '43',
        minimumReceive: '1007001',
        expiresAt: Date.parse(grant) + 60_000
      }
    };
  };
  const withReplacement = () => {
    const previous = withGrantedReturn();
    const authorizedAt = '2026-11-13T16:10:00.000Z';
    return {
      ...previous,
      authorizationRunId: '789',
      recoveredRunId: '789',
      updatedAt: authorizedAt,
      reverseOrderId: undefined,
      reverseRequestAuthority: undefined,
      recoveryReturnReplacement: {
        authorizedAt,
        previous: previous.reverseRequestAuthority,
        previousRunId: '456',
        absentAtBlock: 200
      }
    };
  };
  it('retains the expired return and first grant while freezing one separate replacement window', () => {
    const state = withReplacement();
    const path = join(dir, 'replacement.json');
    saveMainnetSwapCheckpoint(path, state);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject({
      recoveryReturnReplacement: state.recoveryReturnReplacement,
      recoveryReturnAuthorizedAt: state.recoveryReturnAuthorizedAt,
      forwardRequestAuthority: state.forwardRequestAuthority
    });
    expect(loadMainnetSwapCheckpoint(path)?.reverseRequestAuthority).toBeUndefined();
    expect(mainnetSwapRequestExpiresAt(state, 'reverse')).toBe(
      Date.parse(state.recoveryReturnReplacement.authorizedAt) + 300_000
    );
    expect(mainnetSwapRequestExpiresAt(state, 'forward')).toBe(mainnetSwapRequestExpiresAt(withRequest(), 'forward'));
    expect(state.recoveryReturnAuthorizedAt).toBe(withGrantedReturn().recoveryReturnAuthorizedAt);
  });
  it.each([
    'live previous',
    'changed old expiry',
    'unproved absence',
    'foreign previous run',
    'replacement after snapshot'
  ])('refuses replacement provenance with %s', kind => {
    const state = withReplacement();
    if (kind === 'live previous')
      state.recoveryReturnReplacement.authorizedAt = withGrantedReturn().recoveryReturnAuthorizedAt;
    if (kind === 'changed old expiry')
      state.recoveryReturnReplacement.previous.expiresAt = Date.parse(state.recoveryReturnAuthorizedAt) + 300_001;
    if (kind === 'unproved absence') state.recoveryReturnReplacement.absentAtBlock = 0;
    if (kind === 'foreign previous run') state.recoveryReturnReplacement.previousRunId = state.authorizationRunId;
    if (kind === 'replacement after snapshot') state.recoveryReturnReplacement.authorizedAt = '2026-11-14T12:00:00Z';
    const path = join(dir, 'bad-replacement.json');
    writeFileSync(path, JSON.stringify(state));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it.each(['distinct replacement', 'reused expired nonce', 'weakened previous minimum'])(
    'validates active replacement bytes: %s',
    kind => {
      const state = withReplacement();
      const previous = state.recoveryReturnReplacement.previous;
      const active = {
        ...state,
        reverseOrderId: '99',
        reverseRequestAuthority: {
          ...previous,
          nonce: '33333333-3333-4333-8333-333333333333',
          noteId: `0x${'d'.repeat(64)}`,
          sha256: 'e'.repeat(64),
          canonicalSha256: 'f'.repeat(64),
          orderId: '99',
          expiresAt: Date.parse(state.updatedAt) + 60_000
        }
      };
      if (kind === 'reused expired nonce') active.reverseRequestAuthority.nonce = previous.nonce;
      if (kind === 'weakened previous minimum') active.reverseRequestAuthority.minimumReceive = state.reverseMinimum;
      const path = join(dir, 'active-replacement.json');
      writeFileSync(path, JSON.stringify(active));
      if (kind === 'distinct replacement')
        expect(loadMainnetSwapCheckpoint(path)?.reverseRequestAuthority).toEqual(active.reverseRequestAuthority);
      else expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
    }
  );
  it('retains the real pre-claim vault baseline without replacing the original return baseline', () => {
    const state = { ...withGrantedReturn(), recoveryClaimNativeBefore: '8989866' };
    const path = join(dir,'claim-recovery.json'); saveMainnetSwapCheckpoint(path,state);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(state);
  });
  it('accepts a separately granted first recovery return without changing the original forward deadline', () => {
    const recovered = withGrantedReturn();
    const path = join(dir, 'recovery.json');
    saveMainnetSwapCheckpoint(path, recovered);
    expect(loadMainnetSwapCheckpoint(path)).toEqual(recovered);
    expect(recovered.forwardRequestAuthority).toEqual(withRequest().forwardRequestAuthority);
    expect(mainnetSwapRequestExpiresAt(recovered, 'forward')).toBe(Date.parse(recovered.pricedAt) + 300_000);
    expect(mainnetSwapRequestExpiresAt(recovered, 'reverse')).toBe(
      Date.parse(recovered.recoveryReturnAuthorizedAt) + 300_000
    );
    expect(mainnetSwapRequestExpiresAt(withRequest(), 'reverse')).toBe(Date.parse(recovered.pricedAt) + 600_000);
  });
  it.each([
    ['invalid grant', { recoveryReturnAuthorizedAt: 'not-a-date' }],
    ['grant before original authority', { recoveryReturnAuthorizedAt: '2026-11-10T12:00:00Z' }],
    ['grant after persisted record', { recoveryReturnAuthorizedAt: '2026-11-14T12:00:00Z' }],
    ['unsettled original', { phase: 'forward-authorized' }]
  ])('refuses a recovery return with %s', (_name, patch) => {
    const path = join(dir, 'bad-grant.json');
    writeFileSync(path, JSON.stringify({ ...withGrantedReturn(), ...patch }));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it.each(['expired original return', 'extended fresh return', 'renewed forward'])(
    'rejects %s rather than renewing authority',
    kind => {
      const state = withGrantedReturn();
      if (kind === 'expired original return')
        state.reverseRequestAuthority.expiresAt = Date.parse(state.pricedAt) + 600_000;
      if (kind === 'extended fresh return')
        state.reverseRequestAuthority.expiresAt = Date.parse(state.recoveryReturnAuthorizedAt) + 300_001;
      if (kind === 'renewed forward')
        state.forwardRequestAuthority.expiresAt = Date.parse(state.recoveryReturnAuthorizedAt) + 60_000;
      const path = join(dir, 'bad-deadline.json');
      writeFileSync(path, JSON.stringify(state));
      expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
    }
  );
  it('retains the exact signed consume fingerprint and canonical payback identity without private bytes', () => {
    const state = {
      ...withRequest(),
      forwardClaimAuthority: {
        nonce: '22222222-2222-4222-8222-222222222222',
        noteId: `0x${'d'.repeat(64)}`,
        amount: '33650',
        sha256: 'e'.repeat(64),
        canonicalSha256: 'f'.repeat(64),
        requestCanonicalSha256: '9'.repeat(64),
        expiresAt: Date.parse(checkpoint().pricedAt) + 120_000
      }
    };
    const path = join(dir, 'claim.json');
    saveMainnetSwapCheckpoint(path, state);
    expect(loadMainnetSwapCheckpoint(path)).toEqual(state);
    expect(readFileSync(path, 'utf8')).not.toContain('requestBytes');
  });
  it.each([
    ['bad nonce', { nonce: '' }],
    ['bad note', { noteId: '0x12' }],
    ['missing final signed fingerprint', { requestCanonicalSha256: '' }],
    ['under minimum', { amount: '33648' }],
    ['original offered note', { noteId: `0x${'a'.repeat(64)}` }],
    ['reused create nonce', { nonce: '11111111-1111-4111-8111-111111111111' }],
    ['private bytes', { requestBytes: 'private' }]
  ])('rejects a durable claim with %s', (_name, patch) => {
    const state = withRequest();
    const claim = {
      nonce: '22222222-2222-4222-8222-222222222222',
      noteId: `0x${'d'.repeat(64)}`,
      amount: '33650',
      sha256: 'e'.repeat(64),
      canonicalSha256: 'f'.repeat(64),
      requestCanonicalSha256: '9'.repeat(64),
      expiresAt: Date.parse(state.pricedAt) + 120_000,
      ...patch
    };
    const path = join(dir, 'bad-claim.json');
    writeFileSync(path, JSON.stringify({ ...state, forwardClaimAuthority: claim }));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it('matches the actual SDK order and exact reviewed request floor, never merely the older budget floor', () => {
    const state = withRequest();
    expect(matchAuthorizedSwap(state, [{ ...row(), orderId: '42' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(state, [{ ...row(), orderId: '42', minimumReceive: '33650' }], 'forward')?.orderId).toBe(
      '42'
    );
  });
  const corruptRequest: Array<[string, (state: ReturnType<typeof withRequest>) => void]> = [
    [
      'nonce',
      state => {
        state.forwardRequestAuthority.nonce = '';
      }
    ],
    [
      'note identity',
      state => {
        state.forwardRequestAuthority.noteId = '0x12';
      }
    ],
    [
      'actual fingerprint',
      state => {
        state.forwardRequestAuthority.sha256 = '';
      }
    ],
    [
      'canonical fingerprint',
      state => {
        state.forwardRequestAuthority.canonicalSha256 = '';
      }
    ],
    [
      'another actual order',
      state => {
        state.forwardRequestAuthority.orderId = '43';
      }
    ],
    [
      'weaker minimum',
      state => {
        state.forwardRequestAuthority.minimumReceive = '33648';
      }
    ],
    [
      'renewed original price deadline',
      state => {
        state.forwardRequestAuthority.expiresAt += 600_000;
      }
    ],
    [
      'pre-price deadline',
      state => {
        state.forwardRequestAuthority.expiresAt = Date.parse(state.pricedAt);
      }
    ],
    [
      'pre-existing order',
      state => {
        state.knownOrderIds.push('42');
      }
    ],
    [
      'unspent downgrade',
      state => {
        state.phase = 'unspent';
      }
    ]
  ];
  it.each(corruptRequest)('rejects a request authority with %s', (_name, change) => {
    const state = withRequest();
    change(state);
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify(state));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it('rejects private bytes hidden inside an otherwise valid SDK identity', () => {
    const state = withRequest();
    const path = join(dir, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...state,
        forwardRequestAuthority: { ...state.forwardRequestAuthority, request: 'unit-private-bytes' }
      })
    );
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it('accepts the routing suffix emitted by the mainnet SDK address formatter', () => {
    const c = checkpoint();
    c.account = 'mm1dedicatedaccount_qr7qqq9wr6w';
    c.offer.faucetId = c.native.faucetId = 'mm1a_qr7qqq9wr6w';
    const path = join(dir, 'state.json');
    saveMainnetSwapCheckpoint(path, c);
    expect(loadMainnetSwapCheckpoint(path)?.account).toBe(c.account);
  });
  it('distinguishes missing from corrupt state', () => {
    const path = join(dir, 'state.json');
    expect(loadMainnetSwapCheckpoint(path)).toBeUndefined();
    writeFileSync(path, '{');
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it.each(['network', 'amount', 'scale', 'account', 'phase', 'return'])('refuses malformed %s state', mode => {
    const state = JSON.parse(JSON.stringify(checkpoint()));
    if (mode === 'network') state.network = 'testnet';
    if (mode === 'amount') state.principal = '-1';
    if (mode === 'scale') state.offer.decimals = 99;
    if (mode === 'account') state.account = '';
    if (mode === 'phase') state.phase = 'ignore-prior';
    if (mode === 'return') state.phase = 'reverse-authorized';
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify(state));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it('never turns a possibly submitted leg into a new forward leg', () => {
    expect(mainnetSwapNextAction(undefined)).toBe('prepare');
    const c = checkpoint();
    expect(mainnetSwapNextAction(c)).toBe('reconcile-forward');
    c.phase = 'reverse-authorized';
    expect(mainnetSwapNextAction(c)).toBe('reconcile-reverse');
    c.phase = 'forward-settled';
    expect(mainnetSwapNextAction(c)).toBe('return');
    c.phase = 'recovery-required';
    expect(mainnetSwapNextAction(c)).toBe('stop');
    c.phase = 'complete';
    expect(mainnetSwapNextAction(c)).toBe('prepare');
  });
  it('allows a fresh loop only after proven non-submission or a fully reclaimed forward order', () => {
    const c = checkpoint();
    c.phase = 'unspent';
    expect(mainnetSwapNextAction(c)).toBe('prepare');
    c.phase = 'cancelled';
    expect(mainnetSwapNextAction(c)).toBe('prepare');
  });
  it('matches only a unique new order with authorized account, pair and amounts', () => {
    expect(matchAuthorizedSwap(checkpoint(), [row()], 'forward')?.orderId).toBe('2');
    expect(() => matchAuthorizedSwap(checkpoint(), [row(), { ...row(), orderId: '3' }], 'forward')).toThrow(
      /ambiguous/
    );
    expect(matchAuthorizedSwap(checkpoint(), [{ ...row(), orderId: '1' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(checkpoint(), [{ ...row(), account: 'foreign' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(checkpoint(), [{ ...row(), offer: '1010001' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(checkpoint(), [{ ...row(), minimumReceive: '33648' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(checkpoint(), [{ ...row(), initiatedAt: 1 }], 'forward')).toBeUndefined();
  });
  it('uses attributable claimed proceeds, not existing balances or unrelated transfers', () => {
    expect(swapProceeds(123n, 33_772n, 33_649n, 0n)).toBe(33_649n);
    expect(() => swapProceeds(123n, 33_773n, 33_649n, 0n)).toThrow(/unexplained/);
    expect(() => swapProceeds(123n, 33_771n, 33_649n, 0n)).toThrow(/unexplained/);
    expect(swapProceeds(1_000_000n, 2_009_940n, 1_010_000n, 60n)).toBe(1_009_940n);
  });
});
