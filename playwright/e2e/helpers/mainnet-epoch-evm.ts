import { BASE_MANDATE_TYPESTRING, EVM_TO_MIDEN_EXTRA_TYPESTRING, getClaimHash, getCompactTypehash } from '@epoch-protocol/epoch-commons-sdk';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { getAllocatorId, getTokenId } from '@epoch-protocol/epoch-intents-sdk/dist/helpers/chains.js';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isHex, keccak256,
  parseEventLogs, parseTransaction, recoverTransactionAddress, toBytes, zeroAddress, zeroHash,
  type Address, type Hash, type Hex, type TransactionReceipt, type TransactionSerializedEIP1559 } from 'viem';

import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint, type EpochEvmTransaction } from './mainnet-epoch-checkpoint';
import { planEpochRoundTrip } from './mainnet-epoch-ui';

export function inspectEpochForwardReceipt(
  state: MainnetEpochCheckpoint, expectedHash: Hash,
  receipt: Pick<TransactionReceipt, 'transactionHash' | 'status' | 'from' | 'logs'>
): bigint {
  parseMainnetEpochCheckpoint(state);
  if (!state.forwardAuthority || receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase() ||
      receipt.status !== 'success' || receipt.from.toLowerCase() === state.evm.account.toLowerCase())
    throw new Error('Epoch destination receipt is uncorrelated, reverted or self-filled');
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true })
    .filter(log => log.address.toLowerCase() === state.evm.token.toLowerCase() &&
      log.args.to.toLowerCase() === state.evm.account.toLowerCase());
  if (transfers.some(log => log.args.from.toLowerCase() === state.evm.account.toLowerCase()))
    throw new Error('Epoch cannot self-fill its payout');
  const received = transfers.reduce((sum, log) => sum + log.args.value, 0n);
  if (received < BigInt(state.forwardAuthority.minimumOutput)) throw new Error('Epoch receipt underfilled the reviewed output');
  return received;
}

export interface EpochEvmRecoveryEvidence {
  transaction: { hash: Hash; from: Address; to: Address | null; input: Hex; value: bigint; nonce: number;
    chainId?: number; gas: bigint; maxFeePerGas?: bigint; type: string };
  receipt: { transactionHash: Hash; status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint };
}
export function reconcileEpochEvmReceipts(state: MainnetEpochCheckpoint, evidence: readonly EpochEvmRecoveryEvidence[]): boolean {
  parseMainnetEpochCheckpoint(state);
  const journal = state.transactions;
  const authority = state.reverseAuthority;
  if (!journal?.length || journal.length > 3 || evidence.length !== journal.length ||
      !authority || state.evmNonceBefore === undefined) throw new Error('Missing exact Epoch recovery journal');
  const original: MainnetEpochCheckpoint = { ...state, phase: 'reverse-authorized' };
  const reconciled: EpochEvmTransaction[] = [];
  let paid = 0n; let reset = false; let approved = false; let deposited = false; let successful = true;
  for (const [index, entry] of journal.entries()) {
    const item = evidence[index];
    if (!item) throw new Error('Missing Epoch transaction evidence');
    const { transaction: tx, receipt } = item;
    if (!tx.to || tx.hash !== entry.hash || receipt.transactionHash !== entry.hash ||
        getAddress(tx.from) !== getAddress(state.evm.account) || tx.chainId !== state.evm.chainId ||
        tx.type !== 'eip1559' || tx.nonce !== state.evmNonceBefore + index || tx.nonce !== entry.nonce ||
        tx.gas <= 0n || tx.maxFeePerGas === undefined || tx.maxFeePerGas <= 0n ||
        tx.gas * tx.maxFeePerGas > BigInt(state.evmFeeBudget) - paid || receipt.gasUsed <= 0n ||
        receipt.gasUsed > tx.gas || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > tx.maxFeePerGas)
      throw new Error('Epoch receipt differs from its signed journal or original fee envelope');
    let kind: 'approve' | 'deposit' | undefined;
    // Historical byte validation only; never refresh authority or enable another signature.
    for (let expiry = BigInt(authority.minimumExpiry); expiry <= BigInt(authority.maximumExpiry); expiry++) {
      try {
        kind = inspectEpochEvmTransaction(original, { to: tx.to, data: tx.input, value: tx.value }, expiry, Date.parse(authority.preparedAt));
        break;
      } catch { /* Search only the original uploaded expiry range. */ }
    }
    if (!kind || kind !== entry.kind || deposited) throw new Error('Unapproved Epoch recovery execution bytes or sequence');
    if (kind === 'approve') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.input });
      if (decoded.functionName !== 'approve' || approved) throw new Error('Repeated Epoch recovery approval');
      if (decoded.args[1] === 0n) {
        if (reset) throw new Error('Repeated Epoch recovery reset');
        reset = true;
      } else approved = true;
    } else deposited = true;
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (entry.feeWei !== undefined && BigInt(entry.feeWei) !== fee) throw new Error('Contradictory saved Epoch receipt fee');
    reconciled.push({ ...entry, feeWei: fee.toString() }); paid += fee;
    if (receipt.status !== 'success') successful = false;
  }
  if (BigInt(state.paidEvmFees) > paid) throw new Error('Saved Epoch fees exceed their actual receipts');
  state.transactions = reconciled;
  state.paidEvmFees = paid.toString();
  return deposited && successful;
}

export interface EpochEvmEnvelope {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export interface EpochEvmSenderInput {
  client: {
    getChainId(): Promise<number>;
    getTransactionCount(input: { address: Address; blockTag: 'pending' }): Promise<number>;
    getBalance(input: { address: Address }): Promise<bigint>;
    readTokenBalance(): Promise<bigint>;
    readAllowance(): Promise<bigint>;
    estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
    estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
    sendRawTransaction(input: { serializedTransaction: Hex }): Promise<Hash>;
    waitForTransactionReceipt(input: { hash: Hash; timeout: number }): Promise<{
      transactionHash: Hash; status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint;
    }>;
  };
  sign: (transaction: EpochEvmEnvelope) => Promise<Hex>;
  persist: (state: MainnetEpochCheckpoint) => Promise<void>;
}
const isSerializedEip1559 = (raw: Hex): raw is TransactionSerializedEIP1559 =>
  raw.startsWith('0x02') && isHex(raw, { strict: true });

export function createEpochEvmSender(
  state: MainnetEpochCheckpoint, input: EpochEvmSenderInput
): { send: (transaction: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash> } {
  parseMainnetEpochCheckpoint(state);
  if (state.phase !== 'reverse-authorized' || state.transactions?.length || state.evmNonceBefore === undefined ||
      state.returnAmount === undefined || state.forwardReceived === undefined || !state.reverseAuthority)
    throw new Error('Epoch sender requires fresh authority without an unresolved signed journal');
  if (!state.reverseAuthority.valuation) throw new Error('Missing return-stage market valuation before signing');
  const valuation = { ...state.reverseAuthority.valuation };
  const checkValuation = () => {
    const live = state.reverseAuthority?.valuation;
    if (!live || live.pricedAt !== valuation.pricedAt || live.stableUsdMicros !== valuation.stableUsdMicros ||
        live.gasUsdMicros !== valuation.gasUsdMicros) throw new Error('Uploaded Epoch valuation changed');
    const age = Date.now() - Date.parse(valuation.pricedAt);
    if (age < 0 || age > 600_000) throw new Error('Epoch market valuation is stale before signing');
  };
  checkValuation();
  planEpochRoundTrip(state, BigInt(state.returnAmount));
  const nonceBefore = state.evmNonceBefore;
  const amount = BigInt(state.returnAmount);
  const forwardReceived = BigInt(state.forwardReceived);
  const account = getAddress(state.evm.account);
  const { client } = input;
  const minimumExpiry = BigInt(state.reverseAuthority.minimumExpiry);
  const maximumExpiry = BigInt(state.reverseAuthority.maximumExpiry);
  const inspectLive = (transaction: CounterpartyTransaction): 'approve' | 'deposit' => {
    checkValuation();
    const now = Date.now();
    for (let expiry = minimumExpiry; expiry <= maximumExpiry; expiry++) {
      try { return inspectEpochEvmTransaction(state, transaction, expiry, now); }
      catch { /* Try only the original bounded, uploaded expiry window. */ }
    }
    throw new Error('Epoch request does not match any exact compact expiry within its original authority');
  };
  let busy = false;
  let blocked = false;
  let reset = false;
  let approved = false;
  let deposited = false;
  const active = (signal: AbortSignal) => {
    if (blocked || signal.aborted) throw new Error('Epoch signing is blocked or aborted; recovery is required');
  };
  return { send: async (transaction, signal) => {
    if (busy) {
      blocked = true;
      throw new Error('Concurrent Epoch signing is blocked');
    }
    busy = true;
    try {
      active(signal);
      const kind = inspectLive(transaction);
      if (deposited) throw new Error('Epoch deposit was already attempted');
      const checked = { to: getAddress(transaction.to), data: transaction.data, value: transaction.value };
      const allowance = await client.readAllowance();
      let zeroReset = false;
      if (kind === 'approve') {
        const decodedApproval = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
        if (decodedApproval.functionName !== 'approve') throw new Error('Unexpected Epoch approval function');
        zeroReset = decodedApproval.args[1] === 0n;
        if (approved || (zeroReset && reset) || allowance >= amount || (zeroReset && allowance === 0n))
          throw new Error('Repeated or unnecessary Epoch approval');
      } else if (allowance < amount) throw new Error('Epoch deposit lacks its exact token allowance');
      const nonce = nonceBefore + (state.transactions?.length ?? 0);
      if (!Number.isSafeInteger(nonce) || await client.getChainId() !== state.evm.chainId ||
          await client.getTransactionCount({ address: account, blockTag: 'pending' }) !== nonce)
        throw new Error('Epoch live chain or pending nonce changed before signing');
      if (await client.getBalance({ address: account }) !== BigInt(state.evm.nativeBalance) - BigInt(state.paidEvmFees) ||
          await client.readTokenBalance() !== BigInt(state.evm.tokenBalance) + forwardReceived)
        throw new Error('Epoch live portfolio differs from its exact attributed balances');
      const estimatedGas = await client.estimateGas({ account, ...checked });
      const fees = await client.estimateFeesPerGas();
      const maxFeePerGas = fees.maxFeePerGas;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
      if (estimatedGas <= 0n || maxFeePerGas === undefined || maxFeePerGas <= 0n ||
          maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas)
        throw new Error('Invalid Epoch EVM fee estimate');
      const gas = (estimatedGas * 6n + 4n) / 5n;
      const maximumFee = gas * maxFeePerGas;
      if (maximumFee > BigInt(state.evmFeeBudget) - BigInt(state.paidEvmFees))
        throw new Error('Epoch EVM envelope exceeds the remaining fee budget');
      const envelope: EpochEvmEnvelope = {
        ...checked, chainId: state.evm.chainId, nonce, gas, maxFeePerGas, maxPriorityFeePerGas
      };
      active(signal);
      inspectLive(transaction);
      const raw = await input.sign(envelope);
      if (!isSerializedEip1559(raw)) throw new Error('Epoch signer did not produce a serialized EIP-1559 transaction');
      let decoded: ReturnType<typeof parseTransaction>;
      let signer: Address;
      try {
        decoded = parseTransaction(raw);
        signer = await recoverTransactionAddress({ serializedTransaction: raw });
      } catch { throw new Error('Invalid signed Epoch EVM envelope'); }
      if (decoded.type !== 'eip1559' || decoded.chainId !== envelope.chainId || decoded.nonce !== nonce ||
          !decoded.to || getAddress(decoded.to) !== getAddress(envelope.to) ||
          (decoded.data ?? '0x').toLowerCase() !== envelope.data.toLowerCase() ||
          (decoded.value ?? 0n) !== envelope.value || decoded.gas !== gas || decoded.maxFeePerGas !== maxFeePerGas ||
          (decoded.maxPriorityFeePerGas ?? 0n) !== maxPriorityFeePerGas || (decoded.accessList?.length ?? 0) !== 0 ||
          getAddress(signer) !== account)
        throw new Error('Actual signed Epoch envelope or payer differs from its approved transaction');
      const hash = keccak256(raw);
      const entry: EpochEvmTransaction = { kind, nonce, hash };
      state.transactions = [...(state.transactions ?? []), entry];
      await input.persist(state);
      active(signal);
      inspectLive(transaction);
      // The caller must construct this public RPC transport with retryCount: 0.
      const broadcastHash = await client.sendRawTransaction({ serializedTransaction: raw });
      if (broadcastHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Epoch broadcast returned another transaction hash');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.gasUsed <= 0n || receipt.gasUsed > gas ||
          receipt.effectiveGasPrice <= 0n || receipt.effectiveGasPrice > maxFeePerGas)
        throw new Error('Epoch receipt does not match its signed fee envelope');
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      if (fee > maximumFee) throw new Error('Epoch receipt exceeds its reserved all-in fee');
      entry.feeWei = fee.toString();
      state.paidEvmFees = (BigInt(state.paidEvmFees) + fee).toString();
      await input.persist(state);
      if (receipt.status !== 'success') throw new Error('Epoch transaction reverted; fees recorded, no resend');
      if (kind === 'deposit') deposited = true;
      else if (zeroReset) reset = true;
      else approved = true;
      return hash;
    } catch (error) {
      blocked = true;
      throw error;
    } finally { busy = false; }
  } };
}

export function inspectEpochEvmTransaction(
  saved: MainnetEpochCheckpoint,
  transaction: CounterpartyTransaction,
  expiry: bigint,
  now = Date.now()
): 'approve' | 'deposit' {
  const state = parseMainnetEpochCheckpoint(saved);
  const authority = state.reverseAuthority;
  if (state.phase !== 'reverse-authorized' || !authority || !state.returnAmount || state.reverseNonce === undefined)
    throw new Error('No exact Epoch reverse signing authority');
  const preparedAt = Date.parse(authority.preparedAt);
  if (!Number.isSafeInteger(now) || now < preparedAt || now - preparedAt > 300_000 ||
      typeof expiry !== 'bigint' || expiry < BigInt(authority.minimumExpiry) || expiry > BigInt(authority.maximumExpiry))
    throw new Error('Epoch reverse signing authority or compact expiry is stale');
  if (transaction.value !== 0n || !isHex(transaction.data, { strict: true }) || !isHex(authority.lockTag, { strict: true }))
    throw new Error('Unapproved Epoch EVM value or calldata');
  const token = getAddress(state.evm.token);
  const compactAddress = getAddress(state.evm.compact);
  const target = getAddress(transaction.to);
  const amount = BigInt(state.returnAmount);
  const lockTag = BigInt(authority.lockTag);
  if ((lockTag & ((1n << 92n) - 1n)) !== getAllocatorId(getAddress(state.evm.allocator)))
    throw new Error('Epoch lock tag names another allocator');
  if (target === token) {
    for (const approved of [0n, amount]) {
      const expected = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [compactAddress, approved] });
      if (transaction.data.toLowerCase() === expected.toLowerCase()) return 'approve';
    }
  }
  if (target === compactAddress) {
    const witnessType = `${BASE_MANDATE_TYPESTRING},${EVM_TO_MIDEN_EXTRA_TYPESTRING}`;
    const claimHash = getClaimHash({
      arbiter: getAddress(authority.arbiter), sponsor: getAddress(state.evm.account),
      nonce: BigInt(state.reverseNonce), expires: expiry, lockTag,
      id: getTokenId(lockTag, BigInt(token)), token, amount,
      mandate: {
        tokenIn: token, tokenInAmount: state.returnAmount, tokenOut: zeroAddress,
        minTokenOut: state.reverseMinimum, destinationChainId: String(state.virtualChainId),
        taskType: keccak256(toBytes('gettokenout')).slice(0, 10), protocolHashIdentifier: zeroHash,
        recipient: state.evm.account, midenRecipientAccount: state.accountHex, midenFaucetId: state.native.hex
      }
    }, witnessType);
    const expected = encodeFunctionData({ abi: COMPACT_ABI, functionName: 'depositERC20AndRegister', args: [
      token, authority.lockTag, amount, claimHash, getCompactTypehash(witnessType)
    ] });
    if (transaction.data.toLowerCase() === expected.toLowerCase()) return 'deposit';
  }
  throw new Error('Epoch EVM request differs from its exact approved calldata');
}
