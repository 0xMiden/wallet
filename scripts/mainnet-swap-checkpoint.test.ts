/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMainnetSwapCheckpoint,
  mainnetSwapNextAction,
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
  const withRequest = () => ({
    ...checkpoint(), forwardOrderId: '42',
    forwardRequestAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111', noteId: `0x${'a'.repeat(64)}`,
      sha256: 'b'.repeat(64), canonicalSha256: 'c'.repeat(64), orderId: '42', minimumReceive: '33650',
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
    const returned = { ...state, reverseOrderId: '43', reverseRequestAuthority: {
      ...state.forwardRequestAuthority, nonce: '22222222-2222-4222-8222-222222222222', orderId: '43', minimumReceive: '1007001'
    } };
    const path = join(dir, 'state.json');
    saveMainnetSwapCheckpoint(path, returned);
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(returned);
  });
  it('matches the actual SDK order and exact reviewed request floor, never merely the older budget floor', () => {
    const state = withRequest();
    expect(matchAuthorizedSwap(state, [{ ...row(), orderId: '42' }], 'forward')).toBeUndefined();
    expect(matchAuthorizedSwap(state, [{ ...row(), orderId: '42', minimumReceive: '33650' }], 'forward')?.orderId).toBe('42');
  });
  const corruptRequest: Array<[string, (state: ReturnType<typeof withRequest>) => void]> = [
    ['nonce', state => { state.forwardRequestAuthority.nonce = ''; }],
    ['note identity', state => { state.forwardRequestAuthority.noteId = '0x12'; }],
    ['actual fingerprint', state => { state.forwardRequestAuthority.sha256 = ''; }],
    ['canonical fingerprint', state => { state.forwardRequestAuthority.canonicalSha256 = ''; }],
    ['another actual order', state => { state.forwardRequestAuthority.orderId = '43'; }],
    ['weaker minimum', state => { state.forwardRequestAuthority.minimumReceive = '33648'; }],
    ['renewed original price deadline', state => { state.forwardRequestAuthority.expiresAt += 600_000; }],
    ['pre-price deadline', state => { state.forwardRequestAuthority.expiresAt = Date.parse(state.pricedAt); }],
    ['pre-existing order', state => { state.knownOrderIds.push('42'); }],
    ['unspent downgrade', state => { state.phase = 'unspent'; }]
  ];
  it.each(corruptRequest)('rejects a request authority with %s', (_name, change) => {
    const state = withRequest(); change(state);
    const path = join(dir, 'state.json'); writeFileSync(path, JSON.stringify(state));
    expect(() => loadMainnetSwapCheckpoint(path)).toThrow();
  });
  it('rejects private bytes hidden inside an otherwise valid SDK identity', () => {
    const state = withRequest();
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ ...state, forwardRequestAuthority: { ...state.forwardRequestAuthority, request: 'unit-private-bytes' } }));
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
