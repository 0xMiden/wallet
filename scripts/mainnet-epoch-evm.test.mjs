import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toBytes, zeroAddress, zeroHash } from 'viem';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { getTokenId } from '@epoch-protocol/epoch-intents-sdk/dist/helpers/chains.js';
import { BASE_MANDATE_TYPESTRING, EVM_TO_MIDEN_EXTRA_TYPESTRING, getClaimHash, getCompactTypehash } from '@epoch-protocol/epoch-commons-sdk';
import { inspectEpochEvmTransaction } from '../node_modules/.cache/nightly-epoch-evm.mjs';
import { epochCheckpointFixture, epochReverseAuthorityFixture } from '../node_modules/.cache/nightly-epoch-fixture.mjs';

const hash = `0x${'a'.repeat(64)}`;
function fixture() {
  return {
    ...epochCheckpointFixture(), phase: 'reverse-authorized',
    forwardNoteId: hash, forwardMidenTxId: hash, forwardEvmTxHash: hash, forwardReceived: '1001000',
    reverseNonce: '10', returnAmount: '1000501', evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture()
  };
}
const witnessType = `${BASE_MANDATE_TYPESTRING},${EVM_TO_MIDEN_EXTRA_TYPESTRING}`;
function compact(state, expiry) {
  return {
    arbiter: getAddress(state.reverseAuthority.arbiter), sponsor: getAddress(state.evm.account),
    nonce: BigInt(state.reverseNonce), expires: expiry,
    lockTag: BigInt(state.reverseAuthority.lockTag),
    id: getTokenId(BigInt(state.reverseAuthority.lockTag), BigInt(state.evm.token)),
    token: getAddress(state.evm.token), amount: state.returnAmount,
    mandate: {
      tokenIn: state.evm.token, tokenInAmount: state.returnAmount, tokenOut: zeroAddress,
      minTokenOut: state.reverseMinimum, destinationChainId: String(state.virtualChainId),
      taskType: keccak256(toBytes('gettokenout')).slice(0, 10), protocolHashIdentifier: zeroHash,
      recipient: state.evm.account, midenRecipientAccount: state.accountHex, midenFaucetId: state.native.hex
    }
  };
}
function deposit(state, expiry, changed = {}) {
  const data = compact(state, expiry);
  return {
    to: getAddress(state.evm.compact), value: 0n,
    data: encodeFunctionData({ abi: COMPACT_ABI, functionName: 'depositERC20AndRegister', args: [
      getAddress(state.evm.token), state.reverseAuthority.lockTag, BigInt(state.returnAmount),
      getClaimHash({ ...data, ...changed }, witnessType), getCompactTypehash(witnessType)
    ] })
  };
}
function approval(state, amount, spender = state.evm.compact) {
  return { to: getAddress(state.evm.token), value: 0n, data: encodeFunctionData({
    abi: erc20Abi, functionName: 'approve', args: [getAddress(spender), amount]
  }) };
}
function context() {
  const state = fixture();
  return {
    state, expiry: BigInt(state.reverseAuthority.minimumExpiry) + 100n,
    now: Date.parse(state.reverseAuthority.preparedAt) + 1000
  };
}

test('accepts the actual SDK ABI and canonical Compact claim for the exact return authorization', () => {
  const { state, expiry, now } = context();
  assert.equal(inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now), 'deposit');
});
test('accepts only an exact bounded approval or its zero-reset prerequisite', () => {
  const { state, expiry, now } = context();
  assert.equal(inspectEpochEvmTransaction(state, approval(state, BigInt(state.returnAmount)), expiry, now), 'approve');
  assert.equal(inspectEpochEvmTransaction(state, approval(state, 0n), expiry, now), 'approve');
});
for (const [name, change] of [
  ['unlimited approval', (s) => approval(s, (1n << 256n) - 1n)],
  ['another approval spender', (s) => approval(s, BigInt(s.returnAmount), `0x${'9'.repeat(40)}`)],
  ['a direct token transfer', (s) => ({ to: getAddress(s.evm.token), value: 0n, data: encodeFunctionData({
    abi: erc20Abi, functionName: 'transfer', args: [getAddress(s.evm.compact), BigInt(s.returnAmount)]
  }) })],
  ['a native value transfer', (s, e) => ({ ...deposit(s, e), value: 1n })],
  ['another Compact contract', (s, e) => ({ ...deposit(s, e), to: `0x${'9'.repeat(40)}` })],
  ['trailing undeclared calldata', (s, e) => ({ ...deposit(s, e), data: `${deposit(s, e).data}00` })],
  ['a different protocol nonce in the claim', (s, e) => deposit(s, e, { nonce: 11n })],
  ['a different sponsor in the claim', (s, e) => deposit(s, e, { sponsor: getAddress(`0x${'9'.repeat(40)}`) })],
  ['a lower Miden minimum in the claim', (s, e) => deposit(s, e, { mandate: { ...compact(s, e).mandate, minTokenOut: '1' } })]
]) {
  test(`refuses ${name} before signing`, () => {
    const { state, expiry, now } = context();
    assert.throws(() => inspectEpochEvmTransaction(state, change(state, expiry), expiry, now));
  });
}
test('refuses an expiry outside the uploaded authority window even with a matching claim', () => {
  const { state, now } = context();
  const expiry = BigInt(state.reverseAuthority.maximumExpiry) + 1n;
  assert.throws(() => inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now));
});
test('does not extend signing permission when the original prepared authorization expires', () => {
  const { state, expiry } = context();
  const now = Date.parse(state.reverseAuthority.preparedAt) + 300_001;
  assert.throws(() => inspectEpochEvmTransaction(state, deposit(state, expiry), expiry, now));
});
test('requires a reverse-authorized phase instead of reusing settled or ambiguous state', () => {
  const { state, expiry, now } = context();
  for (const phase of ['forward-settled', 'complete', 'recovery-required']) {
    assert.throws(() => inspectEpochEvmTransaction({ ...state, phase }, deposit(state, expiry), expiry, now));
  }
});
