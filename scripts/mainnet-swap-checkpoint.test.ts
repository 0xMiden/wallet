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
    version: 1, network: 'mainnet', account: 'mm1dedicatedaccount', sourceRunId: '123', phase: 'forward-authorized',
    createdAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z',
    offer: { faucetId: 'mm1a', hex: '0x' + '1'.repeat(30), symbol: 'USDCX', decimals: 6, balance: '10000000', usdMicros: '1000000' },
    request: { faucetId: 'mm1b', hex: '0x' + '2'.repeat(30), symbol: 'ETH', decimals: 8, balance: '123', usdMicros: '3000000000' },
    native: { faucetId: 'mm1a', hex: '0x' + '1'.repeat(30), symbol: 'USDCX', decimals: 6, balance: '10000000', usdMicros: '1000000' },
    baseFee: '1', principal: '1010000', forwardMinimum: '33649', reverseMinimum: '1007000',
    knownOrderIds: ['1'], feeBudget: '180', paidFees: '0'
  };
}
const row = (): SwapOrderEvidence => ({
  id: 'tx', orderId: '2', account: 'mm1dedicatedaccount', offeredFaucet: 'mm1a', requestedFaucet: 'mm1b',
  offer: '1010000', minimumReceive: '33649', initiatedAt: 1794398401
});

describe('durable nightly swap authorization', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'swap-checkpoint-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round trips the full authorization with private file permissions', () => {
    const path = join(dir, 'state', 'roundtrip.json');
    saveMainnetSwapCheckpoint(path, checkpoint());
    expect(loadMainnetSwapCheckpoint(path)).toMatchObject(checkpoint());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('key');
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
    expect(() => matchAuthorizedSwap(checkpoint(), [row(), { ...row(), orderId: '3' }], 'forward')).toThrow(/ambiguous/);
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
