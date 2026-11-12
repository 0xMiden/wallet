/** @jest-environment node */
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMainnetEpochCheckpoint,
  saveMainnetEpochCheckpoint,
  parseMainnetEpochCheckpoint,
  mainnetEpochNextAction,
  matchAuthorizedEpoch,
  type MainnetEpochCheckpoint,
  type EpochIntentEvidence
} from '../playwright/e2e/helpers/mainnet-epoch-checkpoint';
import { planEpochRoundTrip } from '../playwright/e2e/helpers/mainnet-epoch-ui';
import { epochCheckpointFixture, epochReverseAuthorityFixture } from './helpers/mainnet-epoch-fixture';

const hash = `0x${'a'.repeat(64)}`;
const nativeHex = '0xe69e6ca6e39df1b10c1e5399399feb';
const accountHex = `0x${'12'.repeat(15)}`;
const evmAccount = `0x${'1'.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
const fixture = epochCheckpointFixture;
function settled(): MainnetEpochCheckpoint {
  return {
    ...fixture(),
    phase: 'forward-settled',
    forwardNoteId: hash,
    forwardMidenTxId: hash,
    forwardEvmTxHash: hash,
    forwardReceived: '1001000'
  };
}
function evidence(): EpochIntentEvidence {
  return {
    nonce: '9',
    sponsor: evmAccount,
    midenAccount: accountHex,
    tokenIn: zero,
    tokenOut: fixture().evm.token,
    tokenInAmount: '1010000',
    minTokenOut: '1000000',
    destinationChainId: 42161,
    recipient: evmAccount
  };
}

const forwardAuthority = () => ({
  minimumOutput: '1000001',
  bindingHash: hash,
  reclaimHeight: 7200,
  mandateReclaimHeight: 2200
});
it('preserves original authorization while persisting the exact reviewed forward floor, binding and both reclaim heights', () => {
  const bound = { ...fixture(), forwardNoteId: hash, forwardAuthority: forwardAuthority() };
  expect(parseMainnetEpochCheckpoint(bound)).toEqual(bound);
  expect(bound.forwardMinimum).toBe('1000000');
  expect(bound.lossBudgetUsdMicros).toBe('1999095');
});
it.each([
  { minimumOutput: '999999' },
  { minimumOutput: '0' },
  { bindingHash: 'not-a-hash' },
  { reclaimHeight: 1.5 },
  { reclaimHeight: 0x1_0000_0000 },
  { mandateReclaimHeight: 7201 },
  { secret: 'must-not-be-serialized' }
])('rejects altered forward collateral authority: %j', changed => {
  expect(() =>
    parseMainnetEpochCheckpoint({
      ...fixture(),
      forwardNoteId: hash,
      forwardAuthority: { ...forwardAuthority(), ...changed }
    })
  ).toThrow();
});
it('does not record a collateral binding without the exact note identity', () => {
  expect(() => parseMainnetEpochCheckpoint({ ...fixture(), forwardAuthority: forwardAuthority() })).toThrow();
});
it('requires settlement to meet the actual stronger reviewed floor, not only the original planning floor', () => {
  expect(parseMainnetEpochCheckpoint({ ...settled(), forwardAuthority: forwardAuthority() })).toEqual({
    ...settled(),
    forwardAuthority: forwardAuthority()
  });
  expect(() =>
    parseMainnetEpochCheckpoint({ ...settled(), forwardReceived: '1000000', forwardAuthority: forwardAuthority() })
  ).toThrow();
});

const consumeAuthority = () => ({
  nonce: '11111111-1111-4111-8111-111111111111',
  sha256: '1'.repeat(64),
  canonicalSha256: '2'.repeat(64)
});
function claimCheckpoint(kind: 'return' | 'refund' = 'return') {
  return {
    ...settled(),
    phase: 'recovery-required',
    forwardAuthority: forwardAuthority(),
    forwardReceived: kind === 'return' ? settled().forwardReceived : undefined,
    reverseNonce: kind === 'return' ? '10' : undefined,
    reverseAuthority: kind === 'return' ? epochReverseAuthorityFixture() : undefined,
    returnNoteId: kind === 'return' ? `0x${'b'.repeat(64)}` : hash,
    consumeAuthority: consumeAuthority()
  };
}
it.each(['return', 'refund'] as const)(
  'persists only actual %s request fingerprints without replacing the original monetary authority',
  kind => {
    const checkpoint = claimCheckpoint(kind);
    expect(parseMainnetEpochCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(checkpoint.authorizationRunId).toBe(fixture().authorizationRunId);
    expect(checkpoint.lossBudgetUsdMicros).toBe(fixture().lossBudgetUsdMicros);
  }
);
it.each([
  { kind: 'other' },
  { noteId: `0x${'b'.repeat(64)}` },
  { nonce: '' },
  { sha256: 'wrong' },
  { canonicalSha256: 'wrong' },
  { rawRequest: [1, 2, 3] },
  { noteFile: 'must-not-be-persisted' }
])('refuses widened, unrelated or private consume authority: %j', changed => {
  expect(() =>
    parseMainnetEpochCheckpoint({ ...claimCheckpoint(), consumeAuthority: { ...consumeAuthority(), ...changed } })
  ).toThrow();
});
it('does not authorize a native return without the original reverse authority', () => {
  expect(() => parseMainnetEpochCheckpoint({ ...claimCheckpoint(), reverseAuthority: undefined })).toThrow();
});
it('does not authorize collateral refund after forward proceeds were recorded', () => {
  expect(() => parseMainnetEpochCheckpoint({ ...claimCheckpoint('refund'), forwardReceived: '1001000' })).toThrow();
});

const valuation = () => ({
  pricedAt: '2026-11-11T12:10:00.000Z',
  stableUsdMicros: '1000000',
  gasUsdMicros: '4000000000'
});
function valuedReverse() {
  return {
    ...settled(),
    phase: 'reverse-authorized' as const,
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: { ...epochReverseAuthorityFixture(), valuation: valuation() }
  };
}
it('records fresh conservative market facts without replacing original authorization prices or budgets', () => {
  const state = valuedReverse();
  expect(parseMainnetEpochCheckpoint(state)).toEqual(state);
  expect(state.evm.nativeUsdMicros).toBe('2000000000');
  expect(state.evmFeeBudget).toBe(fixture().evmFeeBudget);
  expect(state.authorizationRunId).toBe(fixture().authorizationRunId);
});
it('revalidates the whole original gas reserve at the conservative return-stage price', () => {
  expect(planEpochRoundTrip(valuedReverse(), 1_000_501n).nativeFeesUsdMicros).toBe(5000n);
  const expensive = valuedReverse();
  expensive.reverseAuthority.valuation.gasUsdMicros = '3000000000000';
  expect(() => planEpochRoundTrip(expensive, 1_000_501n)).toThrow(/budget|allowance|cost|cap/i);
});
it.each([
  { stableUsdMicros: '999999' },
  { gasUsdMicros: '1999999999' },
  { gasUsdMicros: '0' },
  { pricedAt: 'not-a-time' },
  { pricedAt: '2026-11-11T12:11:00.000Z' },
  { arbitraryFees: 'must-not-be-authority' }
])('refuses weaker, future or undeclared return valuation: %j', changed => {
  const state = valuedReverse();
  expect(() =>
    parseMainnetEpochCheckpoint({
      ...state,
      reverseAuthority: { ...state.reverseAuthority, valuation: { ...valuation(), ...changed } }
    })
  ).toThrow();
});

it('pins a bounded exact reverse compact authority before EVM signing', () => {
  const reverse = {
    ...settled(),
    phase: 'reverse-authorized',
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture()
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
    ...settled(),
    phase: 'reverse-authorized',
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: { ...epochReverseAuthorityFixture(), ...changed }
  };
  expect(() => parseMainnetEpochCheckpoint(reverse)).toThrow();
});

it('pins the live Miden allocator and full reclaim window before authorizing collateral', () => {
  const bound = {
    ...fixture(),
    midenAllocator: '0x593c167bec26769178dcbd1f9bcb40',
    recallBlocks: 6200,
    minimumRecallBlocks: 5200
  };
  expect(parseMainnetEpochCheckpoint(bound)).toEqual(bound);
  for (const bad of [
    { ...bound, midenAllocator: undefined },
    { ...bound, midenAllocator: evmAccount },
    { ...bound, midenAllocator: bound.accountHex },
    { ...bound, recallBlocks: 5199 },
    { ...bound, recallBlocks: 0 },
    { ...bound, minimumRecallBlocks: -1 }
  ])
    expect(() => parseMainnetEpochCheckpoint(bad)).toThrow();
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('preserves the previous checkpoint if its atomic replacement fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epoch-atomic-'));
  const path = join(dir, 'roundtrip.json');
  try {
    saveMainnetEpochCheckpoint(path, fixture());
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk failure');
    });
    try {
      expect(() => saveMainnetEpochCheckpoint(path, { ...fixture(), updatedAt: '2026-11-11T12:01:00.000Z' })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(fixture());
    } finally {
      rename.mockRestore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('does not turn authorization without a receipt into permission for another spend', () => {
  expect(mainnetEpochNextAction(fixture())).toBe('reconcile-forward');
  expect(mainnetEpochNextAction(settled())).toBe('return');
  expect(mainnetEpochNextAction({ ...settled(), phase: 'reverse-authorized' })).toBe('reconcile-reverse');
  expect(mainnetEpochNextAction({ ...fixture(), phase: 'recovery-required' })).toBe('stop');
});
it.each([
  { ...fixture(), network: 'testnet' },
  { ...fixture(), principal: '-1' },
  { ...fixture(), lossBudgetUsdMicros: '2000001' },
  { ...fixture(), evmFeeBudget: '1000000000000000000' },
  { ...fixture(), evm: { ...fixture().evm, chainId: 8453 } },
  { ...fixture(), allocatorUrl: 'http://unsafe.example' },
  { ...fixture(), forwardNonce: 'not-a-nonce' },
  { ...fixture(), secret: 'must-not-be-serialized' },
  { ...settled(), forwardReceived: undefined },
  { ...settled(), phase: 'reverse-authorized', reverseNonce: '10', returnAmount: '1001001', evmNonceBefore: 0 }
])('rejects unsafe financial or incomplete stage evidence %#', value => {
  expect(() => parseMainnetEpochCheckpoint(value)).toThrow();
});
it('requires correlated round-trip evidence and an exact unique-portfolio cost', () => {
  expect(() => parseMainnetEpochCheckpoint({ ...settled(), phase: 'complete', realizedCostUsdMicros: '10' })).toThrow();
  const complete = {
    ...settled(),
    phase: 'complete',
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture(),
    transactions: [{ kind: 'deposit', nonce: 0, hash, feeWei: '200' }],
    paidEvmFees: '200',
    paidMidenFees: '14',
    returnNoteId: `0x${'b'.repeat(64)}`,
    returnMidenTxId: hash,
    reverseReceived: '1000000',
    consumeAuthority: consumeAuthority(),
    after: { native: '19989986', evmToken: '3000499', evmNative: '9999999999999800' },
    realizedCostUsdMicros: '9516'
  };
  expect(parseMainnetEpochCheckpoint(complete)).toEqual(complete);
  expect(() => parseMainnetEpochCheckpoint({ ...complete, consumeAuthority: undefined })).toThrow();
  expect(() => parseMainnetEpochCheckpoint({ ...complete, realizedCostUsdMicros: '9517' })).toThrow();
  const repriced = {
    ...complete,
    reverseAuthority: { ...complete.reverseAuthority, valuation: valuation() },
    transactions: [{ kind: 'deposit', nonce: 0, hash, feeWei: '100000000000' }],
    paidEvmFees: '100000000000',
    after: { ...complete.after, evmNative: '9999900000000000' },
    realizedCostUsdMicros: '9915'
  };
  expect(parseMainnetEpochCheckpoint(repriced)).toEqual(repriced);
  expect(() => parseMainnetEpochCheckpoint({ ...repriced, realizedCostUsdMicros: '9715' })).toThrow();
});
it('matches the exact authorized actor, route, nonce and amount rather than an unrelated intent', () => {
  const valid = evidence();
  expect(matchAuthorizedEpoch(fixture(), [valid], 'forward')).toEqual(valid);
  for (const changed of [
    { ...valid, nonce: '10' },
    { ...valid, sponsor: `0x${'4'.repeat(40)}` },
    { ...valid, midenAccount: nativeHex },
    { ...valid, tokenInAmount: '1010001' },
    { ...valid, minTokenOut: '999999' },
    { ...valid, destinationChainId: 1 },
    { ...valid, recipient: `0x${'4'.repeat(40)}` },
    { ...valid, tokenOut: zero }
  ])
    expect(matchAuthorizedEpoch(fixture(), [changed], 'forward')).toBeUndefined();
  expect(() => matchAuthorizedEpoch(fixture(), [valid, valid], 'forward')).toThrow(/ambiguous/i);
});
