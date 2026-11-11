/** @jest-environment node */
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMainnetEpochCheckpoint, saveMainnetEpochCheckpoint, parseMainnetEpochCheckpoint,
  mainnetEpochNextAction, matchAuthorizedEpoch, type MainnetEpochCheckpoint, type EpochIntentEvidence
} from '../playwright/e2e/helpers/mainnet-epoch-checkpoint';
import { epochCheckpointFixture, epochReverseAuthorityFixture } from './helpers/mainnet-epoch-fixture';

const hash = `0x${'a'.repeat(64)}`;
const nativeHex = '0xe69e6ca6e39df1b10c1e5399399feb';
const accountHex = `0x${'12'.repeat(15)}`;
const evmAccount = `0x${'1'.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
const fixture = epochCheckpointFixture;
function settled(): MainnetEpochCheckpoint {
  return { ...fixture(), phase: 'forward-settled', forwardNoteId: hash, forwardMidenTxId: hash,
    forwardEvmTxHash: hash, forwardReceived: '1001000' };
}
function evidence(): EpochIntentEvidence {
  return { nonce: '9', sponsor: evmAccount, midenAccount: accountHex, tokenIn: zero,
    tokenOut: fixture().evm.token, tokenInAmount: '1010000', minTokenOut: '1000000', destinationChainId: 42161,
    recipient: evmAccount };
}

it('pins a bounded exact reverse compact authority before EVM signing', () => {
  const reverse = {
    ...settled(), phase: 'reverse-authorized', reverseNonce: '10', returnAmount: '1000501',
    evmNonceBefore: 0, reverseAuthority: epochReverseAuthorityFixture()
  };
  expect(parseMainnetEpochCheckpoint(reverse)).toEqual(reverse);
  expect(() => parseMainnetEpochCheckpoint({ ...reverse, reverseAuthority: undefined })).toThrow();
});
it.each([
  { arbiter: `0x${'0'.repeat(40)}` },
  { arbiter: 'not-an-address' },
  { lockTag: '0x12' },
  { preparedAt: '2026-11-10T12:00:00.000Z' },
  { minimumExpiry: '0' },
  { maximumExpiry: '1' },
  { maximumExpiry: (BigInt(epochReverseAuthorityFixture().minimumExpiry) + 301n).toString() },
  { secret: 'must-not-be-serialized' }
])('rejects an altered reverse signer authority: %j', changed => {
  const reverse = {
    ...settled(), phase: 'reverse-authorized', reverseNonce: '10', returnAmount: '1000501', evmNonceBefore: 0,
    reverseAuthority: { ...epochReverseAuthorityFixture(), ...changed }
  };
  expect(() => parseMainnetEpochCheckpoint(reverse)).toThrow();
});

it('pins the live Miden allocator and full reclaim window before authorizing collateral', () => {
  const bound = { ...fixture(), midenAllocator: '0x593c167bec26769178dcbd1f9bcb40', recallBlocks: 6200, minimumRecallBlocks: 5200 };
  expect(parseMainnetEpochCheckpoint(bound)).toEqual(bound);
  for (const bad of [
    { ...bound, midenAllocator: undefined }, { ...bound, midenAllocator: evmAccount },
    { ...bound, midenAllocator: bound.accountHex }, { ...bound, recallBlocks: 5199 },
    { ...bound, recallBlocks: 0 }, { ...bound, minimumRecallBlocks: -1 }
  ]) expect(() => parseMainnetEpochCheckpoint(bad)).toThrow();
});

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
    reverseAuthority: epochReverseAuthorityFixture(),
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
