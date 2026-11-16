import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Address, Endpoint, RpcClient } from '@miden-sdk/miden-sdk';
import { readMainnetSwapPayback } from '../node_modules/.cache/nightly-swap-claim.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const expected = read('test-results/audit-context.json'),
  state = read('test-results/fresh/roundtrip.json');
assert.equal(BigInt(expected.priorSpent) + BigInt(expected.startCap), 2000000n);
assert.equal(state.phase, 'complete');
assert.equal(state.sourceRunId, expected.runId);
assert.equal(state.authorizationRunId, expected.recoveryRunId ?? state.sourceRunId);
if (expected.recoveryRunId) {
  assert.equal(state.recoveredRunId, expected.recoveryRunId);
  assert.equal(typeof state.recoveryReturnAuthorizedAt, 'string');
  const prior = read('test-results/prior/roundtrip.json');
  for (const key of [
    'account',
    'createdAt',
    'pricedAt',
    'offer',
    'request',
    'native',
    'principal',
    'feeBudget',
    'baseFee',
    'lossBudgetUsdMicros',
    'forwardRequestAuthority',
    'forwardClaimAuthority',
    'forwardOrderId',
    'reverseMinimum'
  ])
    assert.deepEqual(state[key], prior[key], key);
  assert.equal(prior.phase, 'forward-settled');
  assert.equal(prior.reverseRequestAuthority, undefined);
  assert.equal(prior.recoveryReturnAuthorizedAt, undefined);
} else assert.equal(state.recoveryReturnAuthorizedAt, undefined);
assert.equal(state.lossBudgetUsdMicros, expected.scheduledRunBudget);
assert.equal(state.native.balance, expected.startNative);
assert.equal(state.recoveryReturnReplacement, undefined);
const rpc = new RpcClient(new Endpoint('https://rpc.mainnet.miden.io'));
let fees = 0n;
for (const leg of ['forward', 'reverse']) {
  const receipt = read(`test-results/fresh-public/mainnet-swap-${leg}-claim.json`),
    created = read(`test-results/${leg}-create/roundtrip.json`),
    claimed = read(`test-results/${leg}-claim/roundtrip.json`);
  const authority = state[`${leg}RequestAuthority`],
    claim = state[`${leg}ClaimAuthority`];
  assert.deepEqual(authority, created[`${leg}RequestAuthority`]);
  assert.deepEqual(claim, claimed[`${leg}ClaimAuthority`]);
  const proof = await readMainnetSwapPayback('https://rpc.mainnet.miden.io', {
    kind: 'swap',
    accountId: Address.fromBech32(state.account).accountId().toString(),
    faucetId: (leg === 'forward' ? state.offer : state.request).hex,
    amount: leg === 'forward' ? state.principal : state.returnAmount,
    requestedFaucetId: (leg === 'forward' ? state.request : state.offer).hex,
    requestedAmount: authority.minimumReceive,
    noteId: authority.noteId,
    orderId: authority.orderId
  });
  assert.ok(proof);
  assert.equal(proof.noteId, receipt.paybackNoteId);
  assert.equal(proof.amount.toString(), receipt.paybackAmount);
  assert.equal(proof.claimedAtBlock, receipt.claimedAtBlock);
  assert.equal(proof.originalCreatedAtBlock, receipt.creationAtBlock);
  assert.equal(proof.createdAtBlock, receipt.paybackCreatedAtBlock);
  assert.equal(claim.noteId, proof.noteId);
  assert.equal(claim.amount, proof.amount.toString());
  const h = await rpc.getBlockHeaderByNumber(proof.claimedAtBlock),
    c = await rpc.getBlockHeaderByNumber(proof.originalCreatedAtBlock);
  assert.ok(h.timestamp() * 1000 <= claim.expiresAt);
  assert.ok(c.timestamp() * 1000 <= authority.expiresAt);
  assert.ok(BigInt(receipt.claimFee) >= 0n && BigInt(receipt.legNativeDebitsBeforeClaim) >= 0n);
  fees += BigInt(receipt.claimFee) + BigInt(receipt.legNativeDebitsBeforeClaim);
}
const receipt = read('test-results/fresh-public/mainnet-swap-reverse-claim.json');
assert.equal(state.paidFees, fees.toString());
assert.equal(receipt.requestFinal, '0');
const debit = BigInt(state.native.balance) - BigInt(receipt.nativeFinal),
  unit = 10n ** BigInt(state.native.decimals),
  price = BigInt(state.native.usdMicros);
assert.ok(price > 0n && unit > 0n);
const cost = debit > 0n ? (debit * price + unit - 1n) / unit : 0n;
assert.equal(state.realizedCostUsdMicros, cost.toString());
const remaining = BigInt(expected.startCap) - cost;
assert.ok(remaining >= 0n);
assert.equal(BigInt(expected.priorSpent) + cost + remaining, 2000000n);
console.log(
  JSON.stringify({
    purpose:
      'keyless scheduled swap settlement, immutable SDK authority and once-only original-task-cap accounting; NOT whole-provider acceptance',
    sourceRunId: state.sourceRunId,
    bothLegsClaimed: true,
    sdkCreateClaimSnapshotsUnchanged: true,
    withinFrozenDeadlines: true,
    fees: fees.toString(),
    nativeFinal: receipt.nativeFinal,
    requestFinal: receipt.requestFinal,
    swapRealizedCostUsdMicros: cost.toString(),
    remainingSharedCapUsdMicros: remaining.toString(),
    priorCostsNotCountedAgain: true,
    profitCredit: false
  })
);
