/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMainnetSwapCheckpoint,
  mainnetSwapNextAction,
  saveMainnetSwapCheckpoint,
  type MainnetSwapCheckpoint
} from '../playwright/e2e/helpers/mainnet-swap-checkpoint';
import { closeSwapHeldDust, type SwapHeldLive } from '../playwright/e2e/helpers/mainnet-swap-held';
import { realizedSwapLoss, swapSearchAmounts } from '../playwright/e2e/helpers/mainnet-swap-plan';
import { swapHeldFixture } from './helpers/mainnet-swap-held-fixture';

const NIGHTLY = '45700000000';
const after = new Date('2026-11-26T03:00:00.000Z').getTime();
const baseline = { offer: 15_350_738n, request: 1732n, native: 15_350_738n };
const live = (over: Partial<SwapHeldLive> = {}): SwapHeldLive => ({
  runId: NIGHTLY,
  now: after,
  balances: baseline,
  payback: {
    originalNoteId: '0x6107cb77b403593c02d5abb41f04ce11ba53252acce61c0474ac62e14d69d920',
    orderId: '5890805803494796975',
    serialZeroOrderId: '1',
    noteId: `0x${'9'.repeat(64)}`,
    amount: 1732n,
    originalCreatedAtBlock: 10,
    createdAtBlock: 11,
    claimedAtBlock: 12
  },
  orders: [],
  pendingWalletRows: 0,
  ...over
});
const roundTrip = (state: MainnetSwapCheckpoint) => JSON.parse(JSON.stringify(state)) as Record<string, any>;

it('closes the unfillable first return as held with the original checkpoint intact and a conservative cost', () => {
  const state = swapHeldFixture();
  const original = swapHeldFixture();
  expect(closeSwapHeldDust(state, live())).toBe(true);
  expect(state.phase).toBe('cancelled');
  expect(state.heldDust).toEqual({
    token: original.request.faucetId,
    amount: '1732',
    reason: 'no_return_liquidity',
    after: { offer: '15350738', request: '1732', native: '15350738' }
  });
  // The dust is not credited: the whole principal and fees count against the cap.
  expect(state.realizedCostUsdMicros).toBe('1000267');
  expect(BigInt(state.realizedCostUsdMicros!)).toBeLessThanOrEqual(BigInt(state.lossBudgetUsdMicros!));
  for (const key of [
    'reverseMinimum',
    'forwardOrderId',
    'forwardRequestAuthority',
    'forwardClaimAuthority',
    'paidFees',
    'feeBudget',
    'lossBudgetUsdMicros',
    'returnAmount',
    'returnBaseline',
    'recoveryReturnAuthorizedAt',
    'authorizationRunId',
    'principal',
    'offer',
    'request',
    'native'
  ] as const)
    expect(state[key]).toEqual(original[key]);
  expect(state.reverseOrderId).toBeUndefined();
  expect(state.reverseRequestAuthority).toBeUndefined();
  expect(mainnetSwapNextAction(state)).toBe('prepare');
  expect(loadMainnetSwapCheckpointFrom(state)).toEqual(state);
});

function loadMainnetSwapCheckpointFrom(state: MainnetSwapCheckpoint): MainnetSwapCheckpoint | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  const path = `${dir}/roundtrip.json`;
  try {
    saveMainnetSwapCheckpoint(path, state);
    return loadMainnetSwapCheckpoint(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mutate = (change: (state: MainnetSwapCheckpoint) => void) => () => {
  const state = swapHeldFixture();
  change(state);
  return state;
};
it.each<[string, () => MainnetSwapCheckpoint, Partial<SwapHeldLive>?]>([
  ['the phase is not reverse-authorized', mutate(s => void (s.phase = 'forward-settled'))],
  ['the source run is not the audited one', mutate(s => void (s.sourceRunId = '45634536471'))],
  ['the return amount is not the audited dust', mutate(s => void (s.returnAmount = '1733'))],
  ['the forward receipt differs from the return amount', mutate(s => void (s.forwardReceived = '1731'))],
  ['a part of the forward was refunded', mutate(s => void (s.forwardRefunded = '1'))],
  ['the grant was never recorded', mutate(s => void delete s.recoveryReturnAuthorizedAt)],
  ['the checkpoint belongs to the running workflow run', mutate(s => void (s.authorizationRunId = NIGHTLY))],
  ['a reverse order was recorded', mutate(s => void (s.reverseOrderId = '77'))],
  [
    'a reverse request authority was recorded',
    mutate(s => void (s.reverseRequestAuthority = { ...s.forwardRequestAuthority!, orderId: '77' }))
  ],
  ['the paid fees exceed the fee budget', mutate(s => void (s.paidFees = '1261'))],
  ['the return baseline is missing', mutate(s => void delete s.returnBaseline)],
  ['the grant has not expired yet', swapHeldFixture as never, { now: Date.parse('2026-11-25T15:09:00.000Z') }],
  ['the offer balance moved', swapHeldFixture as never, { balances: { ...baseline, offer: 15_350_737n } }],
  ['the native balance moved', swapHeldFixture as never, { balances: { ...baseline, native: 15_350_737n } }],
  [
    'the held token balance is below the recorded dust',
    swapHeldFixture as never,
    { balances: { ...baseline, request: 1731n } }
  ],
  [
    'the held token balance is above the recorded dust',
    swapHeldFixture as never,
    { balances: { ...baseline, request: 1733n } }
  ],
  [
    'the original payout is unclaimed',
    swapHeldFixture as never,
    { payback: { ...live().payback!, claimedAtBlock: undefined } }
  ],
  ['the original payout amount differs', swapHeldFixture as never, { payback: { ...live().payback!, amount: 1731n } }],
  [
    'the original payout is for another order',
    swapHeldFixture as never,
    { payback: { ...live().payback!, orderId: '5', serialZeroOrderId: '6' } }
  ],
  [
    'the original payout is for another note',
    swapHeldFixture as never,
    { payback: { ...live().payback!, originalNoteId: `0x${'1'.repeat(64)}` } }
  ],
  ['the original payout is unproved', swapHeldFixture as never, { payback: undefined }],
  ['wallet activity is unresolved', swapHeldFixture as never, { pendingWalletRows: 1 }],
  [
    'an unaccounted swap order exists',
    swapHeldFixture as never,
    {
      orders: [
        {
          id: 'row',
          orderId: '99',
          account: swapHeldFixture().account,
          offeredFaucet: swapHeldFixture().request.faucetId,
          requestedFaucet: swapHeldFixture().offer.faucetId,
          offer: '1732',
          minimumReceive: '996298',
          initiatedAt: Math.floor(Date.parse('2026-11-25T15:05:00.000Z') / 1000)
        }
      ]
    }
  ]
])('stays fail-closed when %s', (_name, build, over = {}) => {
  const state = build();
  const before = JSON.stringify(state);
  expect(closeSwapHeldDust(state, live(over))).toBe(false);
  expect(JSON.stringify(state)).toBe(before);
});

it('stays fail-closed when the projected loss would exceed the budget', () => {
  const state = swapHeldFixture();
  state.lossBudgetUsdMicros = '1000266';
  const before = JSON.stringify(state);
  expect(closeSwapHeldDust(state, live())).toBe(false);
  expect(JSON.stringify(state)).toBe(before);
});

describe('checkpoint schema', () => {
  const closed = () =>
    roundTrip({
      ...swapHeldFixture(),
      phase: 'cancelled',
      realizedCostUsdMicros: '1000267',
      heldDust: {
        token: swapHeldFixture().request.faucetId,
        amount: '1732',
        reason: 'no_return_liquidity',
        after: { offer: '15350738', request: '1732', native: '15350738' }
      }
    });
  const reject = (change: (value: Record<string, any>) => void) => {
    const value = closed();
    change(value);
    expect(() => loadMainnetSwapCheckpointFrom(value as MainnetSwapCheckpoint)).toThrow();
  };
  it('accepts the closed checkpoint', () => {
    expect(loadMainnetSwapCheckpointFrom(closed() as MainnetSwapCheckpoint)?.phase).toBe('cancelled');
  });
  it.each<[string, (value: Record<string, any>) => void]>([
    ['another phase', v => void (v.phase = 'complete')],
    ['a different token', v => void (v.heldDust.token = v.offer.faucetId)],
    ['a different amount', v => void (v.heldDust.amount = '1731')],
    ['an unknown reason', v => void (v.heldDust.reason = 'other')],
    ['an extra marker key', v => void (v.heldDust.extra = '1')],
    ['unattributed after balances', v => void (v.heldDust.after.offer = '15350737')],
    ['unattributed held balance', v => void (v.heldDust.after.request = '1')],
    ['a cost that is not recomputed', v => void (v.realizedCostUsdMicros = '0')],
    ['a cost over the budget', v => void ((v.lossBudgetUsdMicros = '1000266'), (v.realizedCostUsdMicros = '1000267'))],
    ['a missing cost', v => void delete v.realizedCostUsdMicros],
    ['a recorded reverse order', v => void (v.reverseOrderId = '77')],
    [
      'a recorded reverse authority',
      v => void (v.reverseRequestAuthority = { ...v.forwardRequestAuthority, orderId: '77' })
    ],
    ['a refunded forward', v => void (v.forwardRefunded = '1')],
    ['a missing grant', v => void delete v.recoveryReturnAuthorizedAt],
    [
      'an offer that is not the native asset',
      v => void (v.native = { ...v.native, hex: v.request.hex, faucetId: v.request.faucetId })
    ]
  ])('rejects %s', (_name, change) => reject(change));
  it('still rejects a plain cancelled checkpoint without a refund', () => {
    const state = swapHeldFixture();
    state.phase = 'cancelled';
    expect(() => loadMainnetSwapCheckpointFrom(state)).toThrow();
  });
});

describe('later fresh loops', () => {
  const saved = swapHeldFixture();
  const holding = (value: typeof saved.request) => ({
    ...value,
    balance: BigInt(value.balance),
    usdMicros: BigInt(value.usdMicros)
  });
  it('cannot offer the held dust: every search amount is above its balance', () => {
    expect(swapSearchAmounts({ ...holding(saved.request), balance: 1732n })).toEqual([]);
  });
  it('does not count the held dust again when a new loop starts and ends with it', () => {
    const wbtc = { ...holding(saved.request), balance: 1732n };
    const usdc = { ...holding(saved.offer), balance: 15_350_738n };
    expect(
      realizedSwapLoss([
        { before: usdc, after: 15_350_738n },
        { before: wbtc, after: 1732n },
        { before: { ...usdc }, after: 15_350_738n }
      ])
    ).toBe(0n);
  });
});

it('keeps every signing, submission and quoting primitive out of the held closure and its wiring', () => {
  const forbidden =
    /sendRawTransaction|sendTransaction|signTransaction|writeContract|privateKeyToAccount|armMainnet|releaseMainnet|runPreparedSwap|prepareMainnetSwapReview|readLiveSwapLeg|authorizeMainnetSwap|reviewed\.submit|\.submit\(/;
  const helper = readFileSync('playwright/e2e/helpers/mainnet-swap-held.ts', 'utf8');
  const spec = readFileSync('playwright/e2e/tests/mainnet/mainnet-swap-loop.spec.ts', 'utf8');
  const start = spec.indexOf('closeSwapHeldDust(');
  const end = spec.indexOf('if (mode ===', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(spec.slice(start - 600, end)).toContain('readMainnetSwapPayback');
  expect(helper).not.toMatch(forbidden);
  expect(spec.slice(start - 600, end)).not.toMatch(forbidden);
});

it('is wired into the nightly workflow as a resolved terminal phase', () => {
  const workflow = readFileSync('.github/workflows/e2e-mainnet-nightly.yml', 'utf8');
  expect(workflow.match(/\['complete', ?'cancelled', ?'unspent'\]/g)?.length).toBeGreaterThanOrEqual(3);
});
