import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Address, Endpoint, RpcClient } from '@miden-sdk/miden-sdk';
import { createPublicClient, erc20Abi, getAddress, http, decodeFunctionData } from 'viem';
import { mainnet } from 'viem/chains';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { readMainnetSwapPayback } from '../node_modules/.cache/nightly-swap-claim.mjs';
import { reconcileEpochEvmReceipts, inspectEpochForwardReceipt } from '../node_modules/.cache/nightly-epoch-evm.mjs';
import { epochReadOnlyProvider } from '../node_modules/.cache/nightly-epoch-provider.mjs';
import { realizedMainnetLoopLoss } from '../node_modules/.cache/nightly-loop-budget.mjs';
const errorKey = randomBytes(32),
  report = {
    sourceRunId: '44034323631',
    applicationSource: '775f30df7ab450165d82f0f2ddd9ff1742431585',
    sdkVersion: '0.18.0',
    purpose:
      'independent SDK018 original swap settlement and unresolved Epoch Compact escrow; no signature/grant/broadcast/checkpoint mutation',
    status: 'running'
  };
let stage = 'source-binding';
const file = role => `test-results/${role}/roundtrip.json`;
const read = role => JSON.parse(readFileSync(file(role), 'utf8'));
const hash = role =>
  createHash('sha256')
    .update(readFileSync(file(role)))
    .digest('hex');
const expected = {
  swap: '3a9c4166e26092d26c692717207caa72ee00a0fb6ed454a7b99b331abea7fc30',
  epoch: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
  near: '1cba9da167d4223b46d41f5d92894cb25406b6aa7abf8ba12cbf1e93ebd465b5'
};
try {
  assert.equal(JSON.parse(readFileSync('node_modules/@miden-sdk/miden-sdk/package.json', 'utf8')).version, '0.18.0');
  for (const [role, digest] of Object.entries(expected)) assert.equal(hash(role), digest);
  const swap = read('swap'),
    epoch = read('epoch'),
    near = read('near');
  for (const state of [swap, epoch]) {
    assert.equal(state.sourceRunId, '44034323631');
    assert.equal(state.authorizationRunId, state.sourceRunId);
  }
  assert.equal(swap.phase, 'complete');
  assert.equal(epoch.phase, 'recovery-required');
  assert.equal(near.phase, 'unspent');
  assert.equal(near.sourceRunId, '43999834254');
  assert.equal(swap.lossBudgetUsdMicros, '1827631');
  assert.equal(swap.native.balance, '19837087');
  assert.equal(epoch.returnNoteId, undefined);
  assert.equal(epoch.consumeAuthority, undefined);
  assert.equal(epoch.returnMidenTxId, undefined);
  assert.ok(epoch.reverseAuthority?.valuation);
  stage = 'original-sdk018-swap-settlement';
  const rpcUrl = 'https://rpc.mainnet.miden.io',
    rpc = new RpcClient(new Endpoint(rpcUrl));
  let fees = 0n;
  for (const leg of ['forward', 'reverse']) {
    const receipt = JSON.parse(readFileSync(`test-results/public/mainnet-swap-${leg}-claim.json`, 'utf8'));
    const create = read(`${leg}-create`),
      claim = read(`${leg}-claim`),
      authority = swap[`${leg}RequestAuthority`],
      consume = swap[`${leg}ClaimAuthority`];
    assert.deepEqual(authority, create[`${leg}RequestAuthority`]);
    assert.deepEqual(consume, claim[`${leg}ClaimAuthority`]);
    const proof = await readMainnetSwapPayback(rpcUrl, {
      kind: 'swap',
      accountId: Address.fromBech32(swap.account).accountId().toString(),
      faucetId: (leg === 'forward' ? swap.offer : swap.request).hex,
      amount: leg === 'forward' ? swap.principal : swap.returnAmount,
      requestedFaucetId: (leg === 'forward' ? swap.request : swap.offer).hex,
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
    assert.equal(consume.noteId, proof.noteId);
    assert.equal(consume.amount, proof.amount.toString());
    const committed = await rpc.getBlockHeaderByNumber(proof.claimedAtBlock),
      created = await rpc.getBlockHeaderByNumber(proof.originalCreatedAtBlock);
    assert.ok(committed.timestamp() * 1000 <= consume.expiresAt);
    assert.ok(created.timestamp() * 1000 <= authority.expiresAt);
    fees += BigInt(receipt.claimFee) + BigInt(receipt.legNativeDebitsBeforeClaim);
  }
  assert.equal(swap.paidFees, fees.toString());
  const swapReceipt = JSON.parse(readFileSync('test-results/public/mainnet-swap-reverse-claim.json', 'utf8'));
  assert.equal(swapReceipt.requestFinal, '0');
  const debit = BigInt(swap.native.balance) - BigInt(swapReceipt.nativeFinal),
    unit = 10n ** BigInt(swap.native.decimals),
    price = BigInt(swap.native.usdMicros);
  const swapCost = debit > 0n ? (debit * price + unit - 1n) / unit : 0n;
  assert.equal(swapCost.toString(), swap.realizedCostUsdMicros);
  assert.equal(swapCost, 916n);
  assert.equal(epoch.native.balance, swapReceipt.nativeFinal);
  assert.equal(BigInt(epoch.lossBudgetUsdMicros), 1827631n - swapCost);
  stage = 'original-epoch-sdk-and-evm-receipts';
  const originalForward = read('epoch-forward');
  for (const key of [
    'native',
    'evm',
    'principal',
    'forwardMinimum',
    'reverseMinimum',
    'forwardNonce',
    'forwardAuthority',
    'forwardRequestAuthority',
    'createdAt',
    'pricedAt'
  ])
    assert.deepEqual(epoch[key], originalForward[key]);
  const client = createPublicClient({
    chain: mainnet,
    transport: http('https://ethereum.publicnode.com', { retryCount: 0 })
  });
  assert.equal(await client.getChainId(), 1);
  const enable = JSON.parse(readFileSync('test-results/enable/compact-recovery-enable-authority.json', 'utf8'));
  assert.equal(enable.runId, '44055319371');
  assert.equal(enable.sourceSha, '09070f46e3b302d87dfdb15bd31772a8733941da');
  assert.equal(enable.sourceRunId, '44034323631');
  assert.equal(enable.signedHash, '0x07ace35385269a6f107fce317494817e8c6839a07b651ecd50a7c0d018ff4386');
  const [enabledTx, enabledReceipt] = await Promise.all([
    client.getTransaction({ hash: enable.signedHash }),
    client.getTransactionReceipt({ hash: enable.signedHash })
  ]);
  assert.equal(getAddress(enabledTx.from), getAddress(epoch.evm.account));
  assert.equal(getAddress(enabledTx.to), getAddress(epoch.evm.compact));
  assert.equal(enabledTx.nonce, 111);
  assert.equal(enabledTx.value, 0n);
  assert.equal(enabledTx.input, enable.transaction.data);
  for (const key of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas'])
    assert.equal(enabledTx[key], BigInt(enable.transaction[key]));
  assert.equal(enabledReceipt.status, 'success');
  assert.equal(enabledReceipt.transactionHash, enable.signedHash);
  const enableFee = enabledReceipt.gasUsed * enabledReceipt.effectiveGasPrice;
  assert.equal(enableFee, 6724237593578n);
  const enableGasUsd = (enableFee * BigInt(enable.ethUsdMicros) + 10n ** 18n - 1n) / 10n ** 18n;
  assert.equal(enableGasUsd, 12268n);
  assert.ok(enableGasUsd <= BigInt(enable.maximumCostUsdMicros) && enableGasUsd <= 100000n);
  const enabledBlock = await client.getBlock({ blockNumber: enabledReceipt.blockNumber });
  const receipts = await Promise.all(
    epoch.transactions.map(entry =>
      Promise.all([
        client.getTransaction({ hash: entry.hash }),
        client.getTransactionReceipt({ hash: entry.hash })
      ]).then(([transaction, receipt]) => ({ transaction, receipt }))
    )
  );
  const copy = structuredClone(epoch);
  assert.equal(reconcileEpochEvmReceipts(copy, receipts), true);
  assert.deepEqual(copy.transactions, epoch.transactions);
  assert.equal(copy.paidEvmFees, epoch.paidEvmFees);
  assert.equal(
    inspectEpochForwardReceipt(
      epoch,
      epoch.forwardEvmTxHash,
      await client.getTransactionReceipt({ hash: epoch.forwardEvmTxHash })
    ),
    BigInt(epoch.forwardReceived)
  );
  const account = getAddress(epoch.evm.account);
  const [token, gas, latest, pending] = await Promise.all([
    client.readContract({
      address: getAddress(epoch.evm.token),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account]
    }),
    client.getBalance({ address: account }),
    client.getTransactionCount({ address: account, blockTag: 'latest' }),
    client.getTransactionCount({ address: account, blockTag: 'pending' })
  ]);
  assert.equal(latest, 112);
  assert.equal(pending, latest);
  assert.equal(gas, BigInt(epoch.evm.nativeBalance) - BigInt(epoch.paidEvmFees) - enableFee);
  assert.equal(token, BigInt(epoch.evm.tokenBalance) + BigInt(epoch.forwardReceived) - BigInt(epoch.returnAmount));
  stage = 'authenticated-original-compact-principal';
  const tokenId = (BigInt(epoch.reverseAuthority.lockTag) << 160n) | BigInt(epoch.evm.token);
  const compact = getAddress(epoch.evm.compact);
  const [escrow, lock, withdrawal] = await Promise.all([
    client.readContract({ address: compact, abi: COMPACT_ABI, functionName: 'balanceOf', args: [account, tokenId] }),
    client.readContract({ address: compact, abi: COMPACT_ABI, functionName: 'getLockDetails', args: [tokenId] }),
    client.readContract({
      address: compact,
      abi: COMPACT_ABI,
      functionName: 'getForcedWithdrawalStatus',
      args: [account, tokenId]
    })
  ]);
  assert.equal(escrow, BigInt(epoch.returnAmount));
  assert.equal(getAddress(lock[0]), getAddress(epoch.evm.token));
  assert.equal(getAddress(lock[1]), getAddress(epoch.evm.allocator));
  assert.equal(Number(lock[2]), 4);
  assert.equal(Number(lock[3]), 0);
  assert.equal(BigInt(lock[4]), BigInt(epoch.reverseAuthority.lockTag));
  assert.ok(Number(withdrawal[0]) === 1 || Number(withdrawal[0]) === 2);
  assert.equal(withdrawal[1], enabledBlock.timestamp + 3900n);
  assert.equal(withdrawal[1], 1794911867n);
  const deposited = receipts.find((_, i) => epoch.transactions[i].kind === 'deposit');
  assert.ok(deposited);
  const decoded = decodeFunctionData({ abi: COMPACT_ABI, data: deposited.transaction.input });
  assert.equal(decoded.functionName, 'depositERC20AndRegister');
  assert.equal(BigInt(decoded.args[2]), escrow);
  assert.equal(
    await client.readContract({
      address: compact,
      abi: COMPACT_ABI,
      functionName: 'isRegistered',
      args: [account, decoded.args[3], decoded.args[4]]
    }),
    true
  );
  stage = 'original-provider-intent-status';
  const provider = epochReadOnlyProvider(epoch.allocatorUrl, epoch.evm.chainId, account);
  const status = await provider.sdk.getIntentStatus(
    provider.config,
    account,
    epoch.reverseNonce,
    AbortSignal.timeout(30_000)
  );
  assert.ok(Array.isArray(status));
  assert.equal(status.length, 0, 'Original intent state changed; re-evaluate original note/escrow, never replay');
  const nativeExpected = BigInt(epoch.native.balance) - BigInt(epoch.principal) - BigInt(epoch.paidMidenFees);
  const valuation = epoch.reverseAuthority.valuation;
  const accrued = realizedMainnetLoopLoss([
    {
      identity: `miden:${epoch.native.hex}`,
      decimals: 6,
      usdMicros: BigInt(valuation.stableUsdMicros),
      before: BigInt(epoch.native.balance),
      after: nativeExpected
    },
    {
      identity: `evm:1:${epoch.evm.token.toLowerCase()}`,
      decimals: 6,
      usdMicros: BigInt(valuation.stableUsdMicros),
      before: BigInt(epoch.evm.tokenBalance),
      after: token
    },
    {
      identity: 'evm:1:compact_original',
      decimals: 6,
      usdMicros: BigInt(valuation.stableUsdMicros),
      before: 0n,
      after: escrow
    },
    {
      identity: 'evm:1:native',
      decimals: 18,
      usdMicros: BigInt(valuation.gasUsdMicros),
      before: BigInt(epoch.evm.nativeBalance),
      after: gas
    }
  ]);
  assert.ok(accrued >= 0n && accrued < BigInt(epoch.lossBudgetUsdMicros));
  assert.ok(accrued < 200_000n, 'Authenticated held principal must not become loss');
  Object.assign(report, {
    status: 'passed',
    checkpointHashes: expected,
    swapBothLegsOriginalSdkAndPublicSettlementVerified: true,
    withinOriginalSwapDeadlines: true,
    swapCostUsdMicros: swapCost.toString(),
    originalEpochReceiptsSuccessful: true,
    epochPaidEvmFees: epoch.paidEvmFees,
    epochPaidMidenFees: epoch.paidMidenFees,
    nativeExpected: nativeExpected.toString(),
    ethereumToken: token.toString(),
    ethereumGas: gas.toString(),
    ethereumLatestPendingNonce: latest,
    compactTokenId: `0x${tokenId.toString(16)}`,
    compactPrincipal: escrow.toString(),
    compactPrincipalStillOwnedByOriginalAccount: true,
    compactOriginalRegistrationActive: true,
    compactResetPeriod: 4,
    compactForcedWithdrawalStatus: Number(withdrawal[0]),
    originalIntentStatusEmpty: true,
    originalMinimumExpiry: epoch.reverseAuthority.minimumExpiry,
    originalMaximumExpiry: epoch.reverseAuthority.maximumExpiry,
    epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros: accrued.toString(),
    totalAccruedAttemptIncludingEnableUsdMicros: (swapCost + accrued).toString(),
    alreadyBookedOriginalAttemptUsdMicros: '39243',
    newOriginalOwnerEnableGasCostUsdMicros: enableGasUsd.toString(),
    enableHash: enable.signedHash,
    enableFeeWei: enableFee.toString(),
    actualWithdrawableAt: withdrawal[1].toString(),
    bookOnlyNewEnableGasCostOnce: true,
    previousVerifiedSpentUsdMicros: '172369',
    originalTaskCapUsdMicros: '2000000',
    noCostBookedByAudit: true,
    noProfitCredit: true,
    noAuthorityIssued: true,
    noTransactionSent: true,
    providerPrincipalStillUnresolved: true,
    notFundedGreen: true,
    privateCompanionRequired: true
  });
  for (const [role, digest] of Object.entries(expected)) assert.equal(hash(role), digest);
} catch (error) {
  Object.assign(report, {
    status: 'failed',
    stage,
    errorFingerprint: createHmac('sha256', errorKey)
      .update(error instanceof Error ? error.message : 'non-error')
      .digest('hex')
  });
  process.exitCode = 1;
}
writeFileSync('test-results/green02-public-outcome.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
