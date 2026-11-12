import { BASE_MANDATE_TYPESTRING, EVM_TO_MIDEN_EXTRA_TYPESTRING, getClaimHash, getCompactTypehash } from '@epoch-protocol/epoch-commons-sdk';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { getAllocatorId, getTokenId } from '@epoch-protocol/epoch-intents-sdk/dist/helpers/chains.js';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isHex, keccak256,
  parseTransaction, recoverTransactionAddress, toBytes, zeroAddress, zeroHash,
  type Address, type Hash, type Hex, type TransactionSerializedEIP1559 } from 'viem';

import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint, type EpochEvmTransaction } from './mainnet-epoch-checkpoint';

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
  sign: (transaction: EpochEvmEnvelope) => Promise<TransactionSerializedEIP1559>;
  persist: (state: MainnetEpochCheckpoint) => Promise<void>;
}
export function createEpochEvmSender(
  state: MainnetEpochCheckpoint, input: EpochEvmSenderInput
): { send: (transaction: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash> } {
  parseMainnetEpochCheckpoint(state);
  if (state.phase !== 'reverse-authorized' || state.transactions?.length || state.evmNonceBefore === undefined ||
      state.returnAmount === undefined || state.forwardReceived === undefined || !state.reverseAuthority)
    throw new Error('Epoch sender requires fresh authority without an unresolved signed journal');
  const nonceBefore = state.evmNonceBefore;
  const amount = BigInt(state.returnAmount);
  const forwardReceived = BigInt(state.forwardReceived);
  const account = getAddress(state.evm.account);
  const { client } = input;
  const minimumExpiry = BigInt(state.reverseAuthority.minimumExpiry);
  const maximumExpiry = BigInt(state.reverseAuthority.maximumExpiry);
  const inspectLive = (transaction: CounterpartyTransaction): 'approve' | 'deposit' => {
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
          decoded.maxPriorityFeePerGas !== maxPriorityFeePerGas || (decoded.accessList?.length ?? 0) !== 0 ||
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
