/** @jest-environment node */
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMainnetEpochCheckpoint, saveMainnetEpochCheckpoint, parseMainnetEpochCheckpoint,
  mainnetEpochNextAction, matchAuthorizedEpoch, type MainnetEpochCheckpoint, type EpochIntentEvidence
} from '../playwright/e2e/helpers/mainnet-epoch-checkpoint';

const hash = `0x${'a'.repeat(64)}`;
const nativeHex = '0xe69e6ca6e39df1b10c1e5399399feb';
const accountHex = `0x${'12'.repeat(15)}`;
const evmAccount = `0x${'1'.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
function fixture(): MainnetEpochCheckpoint {
  return {
    version: 1, network: 'mainnet', account: `mm1${'a'.repeat(38)}`, accountHex,
    sourceRunId: '100', authorizationRunId: '100', phase: 'forward-authorized',
    createdAt: '2026-11-11T12:00:00.000Z', pricedAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z',
    native: { faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24', hex: nativeHex, symbol: 'USDCX', decimals: 6, balance: '20000000', usdMicros: '1000000' },
    evm: { chainId: 42161, account: evmAccount, token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      allocator: `0x${'2'.repeat(40)}`, compact: `0x${'3'.repeat(40)}`,
      tokenBalance: '3000000', nativeBalance: '10000000000000000', tokenUsdMicros: '1000000', nativeUsdMicros: '2000000000' },
    allocatorUrl: 'https://mainnet-api.epochprotocol.xyz', virtualChainId: 999,
    principal: '1010000', forwardMinimum: '1000000', reverseMinimum: '1000000',
    lossBudgetUsdMicros: '1999095', feeBudget: '1000', evmFeeBudget: '1000000000000', paidMidenFees: '0', paidEvmFees: '0', forwardNonce: '9'
  };
}
function settled(): MainnetEpochCheckpoint {
  return { ...fixture(), phase: 'forward-settled', forwardNoteId: hash, forwardMidenTxId: hash,
    forwardEvmTxHash: hash, forwardReceived: '1001000' };
}
function evidence(): EpochIntentEvidence {
  return { nonce: '9', sponsor: evmAccount, midenAccount: accountHex, tokenIn: zero,
    tokenOut: fixture().evm.token, tokenInAmount: '1010000', minTokenOut: '1000000', destinationChainId: 42161,
    recipient: evmAccount };
}

it('round-trips a valid durable authorization atomically and never treats corrupt state as fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epoch-checkpoint-'));
  const path = join(dir, 'roundtrip.json');
  try {
    expect(loadMainnetEpochCheckpoint(path)).toBeUndefined();
    saveMainnetEpochCheckpoint(path, fixture());
    expect(loadMainnetEpochCheckpoint(path)).toEqual(fixture());
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(fixture());
    expect(readdirSync(dir)).toEqual(['roundtrip.json']);
    writeFileSync(path, '{broken');
    expect(() => loadMainnetEpochCheckpoint(path)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('preserves the previous checkpoint if its atomic replacement fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epoch-atomic-'));
  const path = join(dir, 'roundtrip.json');
  try {
    saveMainnetEpochCheckpoint(path, fixture());
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure'); });
    try {
      expect(() => saveMainnetEpochCheckpoint(path, { ...fixture(), updatedAt: '2026-11-11T12:01:00.000Z' })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(fixture());
    } finally { rename.mockRestore(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('does not turn authorization without a receipt into permission for another spend', () => {
  expect(mainnetEpochNextAction(fixture())).toBe('reconcile-forward');
  expect(mainnetEpochNextAction(settled())).toBe('return');
  expect(mainnetEpochNextAction({ ...settled(), phase: 'reverse-authorized' })).toBe('reconcile-reverse');
  expect(mainnetEpochNextAction({ ...fixture(), phase: 'recovery-required' })).toBe('stop');
});
it.each([
  { ...fixture(), network: 'testnet' }, { ...fixture(), principal: '-1' },
  { ...fixture(), lossBudgetUsdMicros: '2000001' }, { ...fixture(), evmFeeBudget: '1000000000000000000' },
  { ...fixture(), evm: { ...fixture().evm, chainId: 8453 } },
  { ...fixture(), allocatorUrl: 'http://unsafe.example' }, { ...fixture(), forwardNonce: 'not-a-nonce' },
  { ...fixture(), secret: 'must-not-be-serialized' },
  { ...settled(), forwardReceived: undefined },
  { ...settled(), phase: 'reverse-authorized', reverseNonce: '10', returnAmount: '1001001', evmNonceBefore: 0 }
])('rejects unsafe financial or incomplete stage evidence %#', value => {
  expect(() => parseMainnetEpochCheckpoint(value)).toThrow();
});
it('requires correlated round-trip evidence and an exact unique-portfolio cost', () => {
  expect(() => parseMainnetEpochCheckpoint({ ...settled(), phase: 'complete', realizedCostUsdMicros: '10' })).toThrow();
  const complete = {
    ...settled(), phase: 'complete', reverseNonce: '10', returnAmount: '1000501', evmNonceBefore: 0,
    transactions: [{ kind: 'deposit', nonce: 0, hash, feeWei: '200' }], paidEvmFees: '200', paidMidenFees: '14',
    returnNoteId: hash, returnMidenTxId: hash, reverseReceived: '1000000',
    after: { native: '19989986', evmToken: '3000499', evmNative: '9999999999999800' },
    realizedCostUsdMicros: '9516'
  };
  expect(parseMainnetEpochCheckpoint(complete)).toEqual(complete);
  expect(() => parseMainnetEpochCheckpoint({ ...complete, realizedCostUsdMicros: '9517' })).toThrow();
});
it('matches the exact authorized actor, route, nonce and amount rather than an unrelated intent', () => {
  const valid = evidence();
  expect(matchAuthorizedEpoch(fixture(), [valid], 'forward')).toEqual(valid);
  for (const changed of [
    { ...valid, nonce: '10' }, { ...valid, sponsor: `0x${'4'.repeat(40)}` },
    { ...valid, midenAccount: nativeHex }, { ...valid, tokenInAmount: '1010001' },
    { ...valid, minTokenOut: '999999' }, { ...valid, destinationChainId: 1 },
    { ...valid, recipient: `0x${'4'.repeat(40)}` }, { ...valid, tokenOut: zero }
  ]) expect(matchAuthorizedEpoch(fixture(), [changed], 'forward')).toBeUndefined();
  expect(() => matchAuthorizedEpoch(fixture(), [valid, valid], 'forward')).toThrow(/ambiguous/i);
});
