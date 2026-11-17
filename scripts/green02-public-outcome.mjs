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
  const withdraw = JSON.parse(readFileSync('test-results/withdraw/compact-recovery-withdraw-authority.json', 'utf8'));
  assert.equal(withdraw.runId, '44067623911');
  assert.equal(withdraw.sourceSha, '026475b9becfb265e0c739989bdddcf4b4265ee6');
  assert.equal(withdraw.signedHash, '0x72d2c37bf18113cb12904596669d1f2a2ab9f261e2b2949eadf0c9aba550158c');
  const [withdrawTx, withdrawReceipt] = await Promise.all([
    client.getTransaction({ hash: withdraw.signedHash }),
    client.getTransactionReceipt({ hash: withdraw.signedHash })
  ]);
  assert.equal(getAddress(withdrawTx.from), getAddress(epoch.evm.account));
  assert.equal(getAddress(withdrawTx.to), getAddress(epoch.evm.compact));
  assert.equal(withdrawTx.nonce, 112);
  assert.equal(withdrawTx.value, 0n);
  assert.equal(withdrawTx.input, withdraw.transaction.data);
  for (const key of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas'])
    assert.equal(withdrawTx[key], BigInt(withdraw.transaction[key]));
  assert.equal(withdrawReceipt.status, 'success');
  assert.equal(withdrawReceipt.transactionHash, withdraw.signedHash);
  const withdrawCall = decodeFunctionData({ abi: COMPACT_ABI, data: withdrawTx.input });
  assert.equal(withdrawCall.functionName, 'forcedWithdrawal');
  assert.equal(
    BigInt(withdrawCall.args[0]),
    (BigInt(epoch.reverseAuthority.lockTag) << 160n) | BigInt(epoch.evm.token)
  );
  assert.equal(getAddress(withdrawCall.args[1]), getAddress(epoch.evm.account));
  assert.equal(BigInt(withdrawCall.args[2]), BigInt(epoch.returnAmount));
  const transfer = withdrawReceipt.logs.filter(
    log =>
      getAddress(log.address) === getAddress(epoch.evm.token) &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
      log.topics[1]?.slice(26).toLowerCase() === epoch.evm.compact.slice(2).toLowerCase() &&
      log.topics[2]?.slice(26).toLowerCase() === epoch.evm.account.slice(2).toLowerCase() &&
      BigInt(log.data) === BigInt(epoch.returnAmount)
  );
  assert.equal(transfer.length, 1);
  const withdrawFee = withdrawReceipt.gasUsed * withdrawReceipt.effectiveGasPrice;
  assert.equal(withdrawFee, 7322832439915n);
  const withdrawGasUsd = (withdrawFee * BigInt(withdraw.ethUsdMicros) + 10n ** 18n - 1n) / 10n ** 18n;
  assert.equal(withdrawGasUsd, 13365n);
  assert.ok(withdrawGasUsd <= BigInt(withdraw.maximumCostUsdMicros));
  const disableBytes = readFileSync('test-results/disable/compact-recovery-disable-authority.json');
  assert.equal(
    createHash('sha256').update(disableBytes).digest('hex'),
    'b2cbd9e1a2930e6a6b9eb180da2bf709f0585675232fb2d1875bcf08158d8f50'
  );
  const disable = JSON.parse(disableBytes.toString());
  assert.equal(disable.runId, '44071758997');
  assert.equal(disable.sourceSha, '7c6f41bda3e82759349796d8011fb36aed56eaa0');
  assert.equal(disable.signedHash, '0xcae904b38b4711d20e136d0c741be01fd8504184065460ab0caa363f91a66a8d');
  assert.equal(disable.originalRemainingUsdMicros, '1762751');
  const [disableTx, disableReceipt] = await Promise.all([
    client.getTransaction({ hash: disable.signedHash }),
    client.getTransactionReceipt({ hash: disable.signedHash })
  ]);
  assert.equal(getAddress(disableTx.from), getAddress(epoch.evm.account));
  assert.equal(getAddress(disableTx.to), getAddress(epoch.evm.compact));
  assert.equal(disableTx.nonce, 113);
  assert.equal(disableTx.value, 0n);
  assert.equal(disableTx.input, disable.transaction.data);
  for (const key of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas'])
    assert.equal(disableTx[key], BigInt(disable.transaction[key]));
  assert.equal(disableReceipt.status, 'success');
  assert.equal(disableReceipt.transactionHash, disable.signedHash);
  const disableCall = decodeFunctionData({ abi: COMPACT_ABI, data: disableTx.input });
  assert.equal(disableCall.functionName, 'disableForcedWithdrawal');
  assert.equal(BigInt(disableCall.args[0]), (BigInt(epoch.reverseAuthority.lockTag) << 160n) | BigInt(epoch.evm.token));
  const disableFee = disableReceipt.gasUsed * disableReceipt.effectiveGasPrice;
  assert.equal(disableFee, 3377746180430n);
  assert.equal(BigInt(disable.ethUsdMicros), BigInt(epoch.reverseAuthority.valuation.gasUsdMicros));
  const disableGasUsd = (disableFee * BigInt(disable.ethUsdMicros) + 10n ** 18n - 1n) / 10n ** 18n;
  assert.equal(disableGasUsd, 6165n);
  assert.ok(disableGasUsd <= BigInt(disable.maximumCostUsdMicros) && disableGasUsd <= 100000n);
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
  assert.equal(latest, 114);
  assert.equal(pending, latest);
  assert.equal(gas, BigInt(epoch.evm.nativeBalance) - BigInt(epoch.paidEvmFees) - enableFee - withdrawFee - disableFee);
  assert.equal(token, BigInt(epoch.evm.tokenBalance) + BigInt(epoch.forwardReceived));
  assert.equal(token, 254080030n);
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
  assert.equal(escrow, 0n);
  assert.equal(getAddress(lock[0]), getAddress(epoch.evm.token));
  assert.equal(getAddress(lock[1]), getAddress(epoch.evm.allocator));
  assert.equal(Number(lock[2]), 4);
  assert.equal(Number(lock[3]), 0);
  assert.equal(BigInt(lock[4]), BigInt(epoch.reverseAuthority.lockTag));
  assert.equal(enabledBlock.timestamp + 3900n, 1794911867n);
  assert.equal(Number(withdrawal[0]), 0);
  assert.equal(withdrawal[1], 0n);
  const deposited = receipts.find((_, i) => epoch.transactions[i].kind === 'deposit');
  assert.ok(deposited);
  const decoded = decodeFunctionData({ abi: COMPACT_ABI, data: deposited.transaction.input });
  assert.equal(decoded.functionName, 'depositERC20AndRegister');
  assert.equal(BigInt(decoded.args[2]), BigInt(epoch.returnAmount));
  // The primary RPC rejects this historical eth_call; verify the original registration on the measured archive source.
  assert.equal(
    await createPublicClient({
      chain: mainnet,
      transport: http('https://eth.drpc.org', { retryCount: 0 })
    }).readContract({
      address: compact,
      abi: COMPACT_ABI,
      functionName: 'isRegistered',
      args: [account, decoded.args[3], decoded.args[4]],
      blockNumber: deposited.receipt.blockNumber
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
    originalCompactPrincipalReturnedToOriginalOwner: true,
    originalReturnedPrincipal: epoch.returnAmount,
    compactOriginalRegistrationAtOriginalDepositVerified: true,
    originalRegistrationExpiryNeverExtendedOrReissued: true,
    compactResetPeriod: 4,
    compactForcedWithdrawalStatus: Number(withdrawal[0]),
    originalIntentStatusEmpty: true,
    originalMinimumExpiry: epoch.reverseAuthority.minimumExpiry,
    originalMaximumExpiry: epoch.reverseAuthority.maximumExpiry,
    epochAccruedCostExcludingAuthenticatedHeldPrincipalUsdMicros: accrued.toString(),
    totalAccruedAttemptIncludingOwnerRefundUsdMicros: (swapCost + accrued).toString(),
    alreadyBookedOriginalAttemptUsdMicros: '39243',
    newOriginalOwnerEnableGasCostUsdMicros: enableGasUsd.toString(),
    enableHash: enable.signedHash,
    enableFeeWei: enableFee.toString(),
    actualWithdrawableAt: withdrawal[1].toString(),
    alreadyBookedEnableGasCostUsdMicros: '12272',
    alreadyBookedAttemptPlusEnableUsdMicros: '51515',
    newOriginalOwnerWithdrawalGasCostUsdMicros: withdrawGasUsd.toString(),
    withdrawalHash: withdraw.signedHash,
    withdrawalFeeWei: withdrawFee.toString(),
    bookOnlyNewWithdrawalGasCostOnce: false,
    alreadyBookedAttemptPlusEnablePlusWithdrawalUsdMicros: '64880',
    newOriginalOwnerDisableGasCostUsdMicros: disableGasUsd.toString(),
    disableHash: disable.signedHash,
    disableFeeWei: disableFee.toString(),
    forcedWithdrawalDisabled: true,
    bookOnlyNewDisableGasCostOnce: true,
    forcedWithdrawalDisableCleanupRequired: false,
    previousVerifiedSpentUsdMicros: '172369',
    originalTaskCapUsdMicros: '2000000',
    noCostBookedByAudit: true,
    noProfitCredit: true,
    noAuthorityIssued: true,
    noTransactionSent: true,
    providerPrincipalStillUnresolved: false,
    noFreshPayerBeforeDisableAndCanonicalReconciliation: true,
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
