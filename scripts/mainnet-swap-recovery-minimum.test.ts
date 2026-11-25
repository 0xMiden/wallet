/** @jest-environment node */
import {
  authorizeMainnetSwapRecoveryReturn,
  authorizeMainnetSwapReturnReplacement
} from '../playwright/e2e/helpers/mainnet-swap-claim';
import type { MainnetSwapCheckpoint } from '../playwright/e2e/helpers/mainnet-swap-checkpoint';

jest.mock('@miden-sdk/miden-sdk', () => ({}));

const GRANT = '2026-11-13T16:00:00.000Z';
const holding = (usdMicros: string) => ({
  faucetId: 'mm1a',
  hex: '0x' + '1'.repeat(30),
  symbol: 'USDCX',
  decimals: 6,
  balance: '19998056',
  usdMicros
});

// A forward-settled checkpoint holding 1,010,890 units of a 6-decimal stablecoin.
function fixture(reverseMinimum: number, price = '1000000') {
  const state = {
    version: 1,
    network: 'mainnet',
    account: 'mm1dedicatedaccount',
    sourceRunId: '123',
    authorizationRunId: '123',
    phase: 'forward-settled',
    createdAt: '2026-11-13T12:49:42Z',
    pricedAt: '2026-11-13T12:49:33Z',
    updatedAt: '2026-11-13T12:50:16Z',
    offer: holding(price),
    native: holding(price),
    request: { ...holding('999260'), faucetId: 'mm1b', hex: '0x' + '2'.repeat(30), symbol: 'USDT', balance: '0' },
    principal: '1010428',
    forwardMinimum: '1010384',
    reverseMinimum: String(reverseMinimum),
    baseFee: '7',
    feeBudget: '1260',
    paidFees: '266',
    knownOrderIds: [],
    forwardOrderId: '42',
    forwardReceived: '1010890',
    forwardRefunded: '0',
    forwardRequestAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      noteId: '0x' + 'c'.repeat(64),
      sha256: 'a'.repeat(64),
      canonicalSha256: 'b'.repeat(64),
      orderId: '42',
      minimumReceive: '1010384',
      expiresAt: 1794574473000
    }
  } as unknown as MainnetSwapCheckpoint;
  const evidence = {
    originalNoteId: '0x' + 'c'.repeat(64),
    orderId: '7',
    serialZeroOrderId: '42',
    noteId: '0x' + 'd'.repeat(64),
    amount: 1010890n,
    originalCreatedAtBlock: 100,
    createdAtBlock: 101,
    claimedAtBlock: 102
  };
  const balances = { offer: 18987362n, native: 18987362n, request: 1010890n };
  return { state, evidence, balances };
}
const first = (v: ReturnType<typeof fixture>, reviewed?: bigint) =>
  authorizeMainnetSwapRecoveryReturn(v.state, v.evidence, v.balances, '456', GRANT, reviewed);

describe('first swap recovery return near the wallet minimum', () => {
  it('accepts a checkpoint priced 999452 with reverse minimum 996298 and keeps it untouched', () => {
    const result = first(fixture(996298, '999452'));
    expect(result.reverseMinimum).toBe('996298');
    expect(result.recoveryReturnMinimum).toBeUndefined();
  });

  it.each([
    [4999, true],
    [5000, true],
    [5001, false]
  ])('%i micros under the floor accepted=%s', (shortfall, accepted) => {
    const run = () => first(fixture(1_000_000 - shortfall));
    if (accepted) expect(run().phase).toBe('reverse-authorized');
    else expect(run).toThrow(/wallet minimum/);
  });

  it('records a lower reviewed minimum separately and keeps the original', () => {
    const result = first(fixture(995100), 995001n);
    expect(result).toMatchObject({ reverseMinimum: '995100', recoveryReturnMinimum: '995001' });
    expect(() => first(fixture(995100), 994999n)).toThrow(/wallet minimum|allowed shortfall/);
  });

  it('still refuses an over-cap projection inside the relaxed band', () => {
    const v = fixture(995000);
    (v.state as { lossBudgetUsdMicros?: string }).lossBudgetUsdMicros = '16000';
    expect(() => first(v)).toThrow(/loss budget/);
    (v.state as { lossBudgetUsdMicros?: string }).lossBudgetUsdMicros = '25000';
    expect(first(v).phase).toBe('reverse-authorized');
  });

  it('keeps the full wallet minimum for a replacement return', () => {
    const v = fixture(995000);
    const granted = first(v);
    const previous = {
      nonce: '22222222-2222-4222-8222-222222222222',
      noteId: '0x' + 'e'.repeat(64),
      sha256: 'e'.repeat(64),
      canonicalSha256: 'f'.repeat(64),
      orderId: '9',
      minimumReceive: '995000',
      expiresAt: Date.parse(GRANT) + 300000
    };
    const state = { ...granted, reverseRequestAuthority: previous, reverseOrderId: '9' };
    const absence = {
      noteId: previous.noteId,
      atBlock: 200,
      atTime: Date.parse(GRANT) + 599000,
      previousRunId: '456',
      noteCount: 0
    };
    expect(() =>
      authorizeMainnetSwapReturnReplacement(state, v.evidence, v.balances, '789', '2026-11-13T16:10:00.000Z', absence)
    ).toThrow(/wallet minimum/);
  });
});
