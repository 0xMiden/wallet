import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeFunctionData, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { COMPACT_ABI } from '../node_modules/@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';

export const ORIGINAL_COMPACT_RECOVERY = Object.freeze({
  sourceRunId: '44034323631',
  checkpointSha256: '77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1',
  owner: '0xc3B89CeCb0c5C3442A7DBCbBE379351C6bDfF836',
  compact: '0x00000000000000171ede64904551eeDF3C6C9788',
  token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  tokenId: BigInt('0x407c50057d83bedfcde2fb0ca0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  lockTag: '0x407c50057d83bedfcde2fb0c',
  amount: 980858n,
  remainingUsdMicros: 1788388n,
  minimumEthUsdMicros: 1824330000n
});

export async function verifyCompactRecoverySignature(serializedTransaction, intent) {
  const decoded = parseTransaction(serializedTransaction);
  const signer = await recoverTransactionAddress({ serializedTransaction });
  if (
    decoded.type !== 'eip1559' ||
    !isAddressEqual(signer, intent.account) ||
    !isAddressEqual(decoded.to, intent.to) ||
    (decoded.value ?? 0n) !== intent.value ||
    (decoded.maxPriorityFeePerGas ?? 0n) !== intent.maxPriorityFeePerGas ||
    decoded.accessList?.length ||
    ['chainId', 'nonce', 'data', 'gas', 'maxFeePerGas'].some(key => decoded[key] !== intent[key])
  )
    throw new Error('Original Compact signature or frozen transaction fields changed');
  return keccak256(serializedTransaction);
}

export async function broadcastOriginalCompactOnce({
  authorityBytes,
  downloadedBytes,
  binding,
  now,
  markerPath,
  signedHash,
  submit
}) {
  acknowledgeCompactRecovery(authorityBytes, downloadedBytes, binding, now);
  if (JSON.parse(authorityBytes).signedHash !== signedHash)
    throw new Error('Original Compact signed transaction changed after immutable acknowledgement');
  consumeCompactRecoveryAttempt(markerPath, signedHash);
  return await submit();
}

// The caller must compute the digest from original immutable artifact bytes, not reserialize SDK authorities.
export function compactRecoveryIntent(stage, original, live, prior) {
  const c = ORIGINAL_COMPACT_RECOVERY,
    cp = original?.checkpoint;
  if (
    !['enable', 'withdraw', 'disable'].includes(stage) ||
    original?.checkpointSha256 !== c.checkpointSha256 ||
    cp?.sourceRunId !== c.sourceRunId ||
    cp.authorizationRunId !== c.sourceRunId ||
    cp.phase !== 'recovery-required' ||
    cp.returnAmount !== String(c.amount) ||
    cp.returnNoteId ||
    cp.consumeAuthority ||
    cp.returnMidenTxId ||
    cp.evm?.chainId !== 1 ||
    !isAddressEqual(cp.evm.account, c.owner) ||
    !isAddressEqual(cp.evm.compact, c.compact) ||
    !isAddressEqual(cp.evm.token, c.token) ||
    cp.reverseAuthority?.lockTag !== c.lockTag ||
    live?.chainId !== 1 ||
    !isAddressEqual(live.owner, c.owner) ||
    !isAddressEqual(live.compact, c.compact) ||
    live.tokenId !== c.tokenId ||
    live.balance !== (stage === 'disable' ? 0n : c.amount) ||
    !Number.isSafeInteger(live.latestNonce) ||
    live.latestNonce !== { enable: 111, withdraw: 112, disable: 113 }[stage] ||
    live.pendingNonce !== live.latestNonce ||
    !Number.isSafeInteger(live.observedAt) ||
    !Number.isSafeInteger(live.now) ||
    live.now < live.observedAt ||
    live.now - live.observedAt > 120000 ||
    typeof live.blockTimestamp !== 'bigint' ||
    live.blockTimestamp <= 0n ||
    typeof live.remainingUsdMicros !== 'bigint' ||
    live.remainingUsdMicros <= 0n ||
    live.remainingUsdMicros > c.remainingUsdMicros
  )
    throw new Error('Original Compact recovery case changed');
  if (stage === 'enable') {
    if (prior || live.status !== 0 || live.withdrawableAt !== 0n)
      throw new Error('Original Compact initializer is already consumed or pending');
  } else {
    const enabled = prior?.enable;
    if (
      !enabled?.success ||
      !/^0x[0-9a-f]{64}$/i.test(enabled.hash) ||
      enabled.nonce !== 111 ||
      !isAddressEqual(enabled.owner, c.owner) ||
      !isAddressEqual(enabled.compact, c.compact) ||
      enabled.tokenId !== c.tokenId ||
      typeof enabled.withdrawableAt !== 'bigint' ||
      enabled.withdrawableAt <= 0n ||
      enabled.withdrawableAt !== live.withdrawableAt ||
      live.status !== 2 ||
      live.blockTimestamp < live.withdrawableAt
    )
      throw new Error('Original Compact timer or confirmed initializer is not ready');
    if (stage === 'disable') {
      const withdrawn = prior.withdraw;
      if (
        !withdrawn?.success ||
        !/^0x[0-9a-f]{64}$/i.test(withdrawn.hash) ||
        withdrawn.hash === enabled.hash ||
        withdrawn.nonce !== 112 ||
        !isAddressEqual(withdrawn.owner, c.owner) ||
        !isAddressEqual(withdrawn.recipient, c.owner) ||
        !isAddressEqual(withdrawn.compact, c.compact) ||
        withdrawn.tokenId !== c.tokenId ||
        withdrawn.amount !== c.amount
      )
        throw new Error('Original principal return is not independently confirmed');
    } else if (prior.withdraw) throw new Error('Original Compact withdrawal is already consumed');
  }
  return {
    chainId: 1,
    account: c.owner,
    to: c.compact,
    value: 0n,
    nonce: live.latestNonce,
    data: encodeFunctionData({
      abi: COMPACT_ABI,
      functionName: {
        enable: 'enableForcedWithdrawal',
        withdraw: 'forcedWithdrawal',
        disable: 'disableForcedWithdrawal'
      }[stage],
      args: stage === 'withdraw' ? [c.tokenId, c.owner, c.amount] : [c.tokenId]
    })
  };
}

export function assertCompactRecoveryFees(transaction, ethUsdMicros, remainingUsdMicros) {
  const { gas, maxFeePerGas, maxPriorityFeePerGas } = transaction;
  if (
    typeof gas !== 'bigint' ||
    gas <= 0n ||
    gas > 80000n ||
    typeof maxFeePerGas !== 'bigint' ||
    maxFeePerGas <= 0n ||
    typeof maxPriorityFeePerGas !== 'bigint' ||
    maxPriorityFeePerGas < 0n ||
    maxPriorityFeePerGas > maxFeePerGas ||
    typeof ethUsdMicros !== 'bigint' ||
    ethUsdMicros < ORIGINAL_COMPACT_RECOVERY.minimumEthUsdMicros ||
    typeof remainingUsdMicros !== 'bigint' ||
    remainingUsdMicros <= 0n ||
    remainingUsdMicros > ORIGINAL_COMPACT_RECOVERY.remainingUsdMicros
  )
    throw new Error('Original Compact gas bound is invalid');
  const maximumCost = (gas * maxFeePerGas * ethUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
  if (maximumCost > 100000n || maximumCost > remainingUsdMicros)
    throw new Error('Original Compact recovery exceeds its remaining gas allowance');
  return maximumCost;
}

export function acknowledgeCompactRecovery(authorityBytes, downloadedBytes, binding, now) {
  if (authorityBytes !== downloadedBytes) throw new Error('Original Compact immutable bytes changed');
  const journal = JSON.parse(authorityBytes);
  if (
    journal.version !== 1 ||
    journal.sourceRunId !== ORIGINAL_COMPACT_RECOVERY.sourceRunId ||
    journal.checkpointSha256 !== ORIGINAL_COMPACT_RECOVERY.checkpointSha256 ||
    !/^\d+$/.test(journal.runId) ||
    journal.runId !== binding.runId ||
    !/^[0-9a-f]{40}$/.test(journal.sourceSha) ||
    journal.sourceSha !== binding.sourceSha ||
    !['enable', 'withdraw', 'disable'].includes(journal.stage) ||
    journal.stage !== binding.stage ||
    !/^0x[0-9a-f]{64}$/i.test(journal.signedHash) ||
    !Number.isSafeInteger(journal.preparedAt) ||
    journal.preparedAt < 0 ||
    journal.expiresAt !== journal.preparedAt + 240000 ||
    !Number.isSafeInteger(now) ||
    now < journal.preparedAt ||
    now >= journal.expiresAt
  )
    throw new Error('Original Compact immutable acknowledgement is not authorized');
}

export function consumeCompactRecoveryAttempt(path, signedHash) {
  if (!/^0x[0-9a-f]{64}$/i.test(signedHash)) throw new Error('Original Compact signed hash is missing');
  const file = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(file, `${signedHash}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
