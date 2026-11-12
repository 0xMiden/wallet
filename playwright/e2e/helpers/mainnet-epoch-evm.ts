import { BASE_MANDATE_TYPESTRING, EVM_TO_MIDEN_EXTRA_TYPESTRING, getClaimHash, getCompactTypehash } from '@epoch-protocol/epoch-commons-sdk';
import { COMPACT_ABI } from '@epoch-protocol/epoch-intents-sdk/dist/abis/compact.js';
import { getAllocatorId, getTokenId } from '@epoch-protocol/epoch-intents-sdk/dist/helpers/chains.js';
import { encodeFunctionData, erc20Abi, getAddress, isHex, keccak256, toBytes, zeroAddress, zeroHash,
  type Address, type Hash, type Hex } from 'viem';

import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

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
export function createEpochEvmSender(
  _state: MainnetEpochCheckpoint, _expiry: bigint, _input: EpochEvmSenderInput
): { send: (transaction: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash> } {
  return { send: async () => { throw new Error('Bounded Epoch EVM sender is not implemented'); } };
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
