import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Endpoint, RpcClient, NoteId, getWrappedSdk } from '@miden-sdk/miden-sdk';
import { createPublicClient, erc20Abi, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';
import { reconcileEpochEvmReceipts, inspectEpochForwardReceipt } from '../node_modules/.cache/nightly-epoch-evm.mjs';
import { inspectEpochReturnNote, mainnetConsumeRequestHash } from '../node_modules/.cache/nightly-epoch-request.mjs';
import { readMainnetSwapCommitHeight } from '../node_modules/.cache/nightly-swap-claim.mjs';
import { verifyMainnetMidenNoteInclusion } from '../node_modules/.cache/nightly-miden-read.mjs';
import { realizedMainnetLoopLoss } from '../node_modules/.cache/nightly-loop-budget.mjs';

const read = name => JSON.parse(readFileSync(`test-results/${name}/roundtrip.json`, 'utf8'));
const context = JSON.parse(readFileSync('test-results/audit-context.json', 'utf8'));
const state = read('final'),
  original = read('original'),
  forward = read('forward-sdk');
const authority = read('authority'),
  signed1 = read('evm1'),
  signed2 = read('evm2'),
  claim = read('claim');
const swap = read('fresh'),
  near = read('near');
assert.equal(
  createHash('sha256').update(readFileSync('test-results/final/roundtrip.json')).digest('hex'),
  '6ca09782587d50227093cdbef7ee40a8d1817440508b58933ab7a26094cce6c7'
);
assert.equal(state.phase, 'complete');
assert.equal(state.sourceRunId, context.runId);
assert.equal(state.authorizationRunId, state.sourceRunId);
for (const key of [
  'sourceRunId',
  'authorizationRunId',
  'createdAt',
  'pricedAt',
  'native',
  'evm',
  'principal',
  'forwardMinimum',
  'reverseMinimum',
  'lossBudgetUsdMicros',
  'feeBudget',
  'evmFeeBudget',
  'forwardNonce',
  'allocatorUrl',
  'virtualChainId',
  'midenAllocator',
  'recallBlocks',
  'minimumRecallBlocks'
])
  assert.deepEqual(state[key], original[key]);
assert.deepEqual(state.forwardRequestAuthority, forward.forwardRequestAuthority);
for (const snapshot of [authority, signed1, signed2, claim])
  for (const key of ['reverseNonce', 'returnAmount', 'evmNonceBefore', 'reverseAuthority'])
    assert.deepEqual(snapshot[key], state[key]);
for (const [index, snapshot] of [signed1, signed2].entries())
  for (let i = 0; i <= index; i++)
    for (const key of ['hash', 'kind', 'nonce'])
      assert.equal(snapshot.transactions[i][key], state.transactions[i][key]);
assert.deepEqual(claim.consumeAuthority, state.consumeAuthority);
assert.equal(claim.returnNoteId, state.returnNoteId);
assert.equal(state.evm.chainId, 1);
assert.equal(state.evm.tokenBalance, '253023110');
assert.equal(state.evm.nativeBalance, '297591195790226079');
const client = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum.publicnode.com', { retryCount: 0 })
});
assert.equal(await client.getChainId(), 1);
const receipts = await Promise.all(
  state.transactions.map(async entry => ({
    transaction: await client.getTransaction({ hash: entry.hash }),
    receipt: await client.getTransactionReceipt({ hash: entry.hash })
  }))
);
const copy = structuredClone(state);
assert.equal(reconcileEpochEvmReceipts(copy, receipts), true);
assert.deepEqual(copy.transactions, state.transactions);
assert.equal(copy.paidEvmFees, state.paidEvmFees);
assert.equal(state.paidEvmFees, '23132535114996');
assert.equal(
  inspectEpochForwardReceipt(
    state,
    state.forwardEvmTxHash,
    await client.getTransactionReceipt({ hash: state.forwardEvmTxHash })
  ),
  999847n
);
const account = getAddress(state.evm.account);
const [token, gas, latest, pending] = await Promise.all([
  client.readContract({
    address: getAddress(state.evm.token),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account]
  }),
  client.getBalance({ address: account }),
  client.getTransactionCount({ address: account, blockTag: 'latest' }),
  client.getTransactionCount({ address: account, blockTag: 'pending' })
]);
assert.equal(token, 253042125n);
assert.equal(gas, 297568063255111083n);
assert.equal(latest, 105);
assert.equal(pending, latest);
assert.equal(state.after.evmToken, token.toString());
assert.equal(state.after.evmNative, gas.toString());
assert.equal(token, BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived) - BigInt(state.returnAmount));
assert.equal(gas, BigInt(state.evm.nativeBalance) - BigInt(state.paidEvmFees));
const rpcUrl = 'https://rpc.mainnet.miden.io',
  rpc = new RpcClient(new Endpoint(rpcUrl));
const notes = await rpc.getNotesById([NoteId.fromHex(state.returnNoteId)]);
assert.equal(notes.length, 1);
const item = notes[0];
assert.ok(item?.note);
const created = item.inclusionProof.location().blockNum();
await verifyMainnetMidenNoteInclusion(rpcUrl, state.returnNoteId, created, item.metadata.sender().toString());
const sdk = getWrappedSdk(),
  bytes = Uint8Array.from(
    sdk.NoteFile.fromInputNote(sdk.InputNote.authenticated(item.note, item.inclusionProof)).serialize()
  );
assert.equal(inspectEpochReturnNote(state, state.returnNoteId, bytes), 980341n);
assert.equal(mainnetConsumeRequestHash(bytes, true), state.consumeAuthority.canonicalSha256);
const consumed = await readMainnetSwapCommitHeight(rpc, item.note, created);
assert.ok(Number.isSafeInteger(consumed) && consumed >= created);
assert.ok((await rpc.getBlockHeaderByNumber(consumed)).timestamp() * 1000 <= state.consumeAuthority.expiresAt);
const native = BigInt(state.after.native);
assert.equal(native, 19879573n);
assert.equal(state.paidMidenFees, '266');
assert.equal(native, BigInt(state.native.balance) - BigInt(state.principal) + BigInt(state.reverseReceived) - 266n);
const swapReceipt = JSON.parse(readFileSync('test-results/fresh-public/mainnet-swap-reverse-claim.json', 'utf8'));
assert.equal(state.native.balance, swapReceipt.nativeFinal);
const valuation = state.reverseAuthority.valuation;
const cost = realizedMainnetLoopLoss([
  {
    identity: `miden:${state.native.hex}`,
    decimals: 6,
    usdMicros: BigInt(valuation.stableUsdMicros),
    before: BigInt(state.native.balance),
    after: native
  },
  {
    identity: `evm:1:${state.evm.token.toLowerCase()}`,
    decimals: 6,
    usdMicros: BigInt(valuation.stableUsdMicros),
    before: BigInt(state.evm.tokenBalance),
    after: token
  },
  {
    identity: 'evm:1:native',
    decimals: 18,
    usdMicros: BigInt(valuation.gasUsdMicros),
    before: BigInt(state.evm.nativeBalance),
    after: gas
  }
]);
assert.equal(cost, 43229n);
assert.equal(cost.toString(), state.realizedCostUsdMicros);
assert.equal(swap.realizedCostUsdMicros, '936');
assert.equal(BigInt(state.lossBudgetUsdMicros), BigInt(context.scheduledRunBudget) - 936n);
assert.equal(BigInt(near.lossBudgetUsdMicros), BigInt(context.scheduledRunBudget) - 936n - cost);
assert.equal(near.sourceRunId, context.runId);
assert.equal(near.phase, 'forward-authorized');
assert.equal(near.native.balance, native.toString());
assert.ok(near.forwardQuote);
assert.equal(near.sendAuthority, undefined);
assert.equal(near.forwardMidenTxId, undefined);
assert.equal(near.paidMidenFees, '0');
assert.equal(near.paidEvmFees, '0');
assert.ok(Date.parse(near.forwardQuote.deadline) < Date.now());
const total = 936n + cost,
  remaining = BigInt(context.startCap) - total;
assert.equal(remaining, 1909754n);
assert.equal(BigInt(context.priorSpent) + total + remaining, 2000000n);
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/0xMiden/wallet/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30000)
  });
  assert.ok(response.ok);
  return response.json();
}
const run = await github(`actions/runs/${context.runId}`),
  jobs = await github(`actions/runs/${context.runId}/jobs?per_page=100`),
  artifacts = await github(`actions/runs/${context.runId}/artifacts?per_page=100`);
assert.equal(run.head_sha, '7fccdbfc371cdefc542b45af51de192032a8d415');
assert.equal(run.run_attempt, 1);
assert.equal(run.event, 'schedule');
assert.equal(run.conclusion, 'failure');
const steps = jobs.jobs.flatMap(job => job.steps ?? []);
assert.deepEqual(
  steps.filter(step => step.conclusion === 'failure').map(step => step.name),
  ['Upload NEAR native forward authority', 'Verify no new provider principal remains unresolved']
);
for (const name of [
  'Wait for mainnet swap return',
  'Wait for mainnet Epoch return',
  'Upload Epoch SDK forward authority',
  'Upload Epoch reverse authority'
])
  assert.equal(steps.filter(step => step.name === name && step.conclusion === 'success').length, 1);
assert.ok(!artifacts.artifacts.some(a => /near.*(authorized|sdk|signed)/i.test(a.name)));
const report = {
  purpose:
    'independent scheduled swap+Epoch settlement and expired unsigned NEAR quote, not NEAR settlement or authority cancellation',
  run: context.runId,
  bothSwapLegsClaimed: true,
  epochComplete: true,
  immutableSdkSnapshotsVerified: true,
  returnClaimWithinDeadline: true,
  publicEvmToken: token.toString(),
  publicEvmGas: gas.toString(),
  latestNonce: latest,
  pendingNonce: pending,
  nativeRequiresPrivateCompanion: native.toString(),
  swapCostUsdMicros: '936',
  epochCostUsdMicros: cost.toString(),
  newTotalUsdMicros: total.toString(),
  originalTaskPriorSpentUsdMicros: context.priorSpent,
  originalTaskRemainingUsdMicros: remaining.toString(),
  scheduledRunAllowanceNotRebound: true,
  nearHasNoSendAuthority: true,
  nearQuoteExpired: true,
  nearCheckpointRequiresCanonicalRecovery: true,
  noNewGrantOrSignature: true,
  noProfitCredit: true,
  noDoubleDeduction: true
};
writeFileSync('test-results/scheduled-public-audit.json', JSON.stringify(report));
console.log(JSON.stringify(report));
