import type { Address, Hash, Hex, Transaction } from 'viem';

export interface SourceTransaction {
  chainId: number;
  hash: Hash;
  from: Address;
  nonce: number;
  to: Address | null;
  input: Hex;
  value: string;
}
export type SourceRpcTransaction = Pick<
  Transaction,
  'hash' | 'from' | 'nonce' | 'to' | 'input' | 'value' | 'blockNumber'
>;
export interface SourceTransactionClient {
  getTransaction(args: { hash: Hash }): Promise<SourceRpcTransaction>;
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>;
  getTransactionCount(args: { address: Address; blockNumber: bigint }): Promise<number>;
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<{
    timestamp: bigint;
    transactions: SourceRpcTransaction[];
  }>;
}
export interface SourceTransactionResolution {
  transaction?: SourceTransaction;
  replacement?: SourceTransaction;
  reason?: 'repriced' | 'cancelled' | 'replaced';
  timestamp?: number;
  uncertain?: true;
}
export function parseSourceTransaction(_value: unknown): SourceTransaction {
  throw new Error('Unsupported source identity');
}
export function replacementReason(
  _original: SourceTransaction,
  _replacement: SourceTransaction
): 'repriced' | 'cancelled' | 'replaced' {
  throw new Error('Unsupported replacement');
}
export async function captureSourceTransaction(
  _client: SourceTransactionClient,
  _chainId: number,
  _hash: Hash
): Promise<SourceTransaction | undefined> {
  throw new Error('Unsupported source capture');
}
export async function recoverSourceTransaction(
  _client: SourceTransactionClient,
  _chainId: number,
  _hash: Hash,
  _saved?: SourceTransaction
): Promise<SourceTransactionResolution> {
  throw new Error('Unsupported source recovery');
}
