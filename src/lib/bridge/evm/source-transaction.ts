import {
  isAddress,
  isHash,
  isHex,
  TransactionNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type Transaction
} from 'viem';

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

export function parseSourceTransaction(value: unknown): SourceTransaction {
  if (!value || typeof value !== 'object') throw new Error('Invalid source transaction identity');
  const chainId: unknown = Reflect.get(value, 'chainId');
  const hash: unknown = Reflect.get(value, 'hash');
  const from: unknown = Reflect.get(value, 'from');
  const nonce: unknown = Reflect.get(value, 'nonce');
  const to: unknown = Reflect.get(value, 'to');
  const input: unknown = Reflect.get(value, 'input');
  const amount: unknown = Reflect.get(value, 'value');
  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    typeof hash !== 'string' ||
    !isHash(hash) ||
    typeof from !== 'string' ||
    !isAddress(from, { strict: false }) ||
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    (to !== null && (typeof to !== 'string' || !isAddress(to, { strict: false }))) ||
    typeof input !== 'string' ||
    !isHex(input, { strict: true }) ||
    input.length % 2 !== 0 ||
    typeof amount !== 'string' ||
    !/^\d+$/.test(amount)
  )
    throw new Error('Invalid source transaction identity');
  return { chainId, hash, from, nonce, to, input, value: amount };
}

export function replacementReason(
  original: SourceTransaction,
  replacement: SourceTransaction
): 'repriced' | 'cancelled' | 'replaced' {
  const before = parseSourceTransaction(original);
  const after = parseSourceTransaction(replacement);
  if (
    before.chainId !== after.chainId ||
    before.from.toLowerCase() !== after.from.toLowerCase() ||
    before.nonce !== after.nonce
  )
    throw new Error('Source replacement identity changed');
  if (
    before.to?.toLowerCase() === after.to?.toLowerCase() &&
    before.input.toLowerCase() === after.input.toLowerCase() &&
    BigInt(before.value) === BigInt(after.value)
  )
    return 'repriced';
  return after.to?.toLowerCase() === before.from.toLowerCase() && after.input === '0x' && BigInt(after.value) === 0n
    ? 'cancelled'
    : 'replaced';
}

async function getTransaction(client: SourceTransactionClient, hash: Hash): Promise<SourceRpcTransaction | undefined> {
  try {
    return await client.getTransaction({ hash });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) return undefined;
    throw error;
  }
}

export async function captureSourceTransaction(
  client: SourceTransactionClient,
  chainId: number,
  hash: Hash
): Promise<SourceTransaction | undefined> {
  const transaction = await getTransaction(client, hash);
  if (!transaction) return undefined;
  const identity = parseSourceTransaction({ ...transaction, chainId, value: transaction.value.toString() });
  if (identity.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('Source transaction hash changed');
  return identity;
}

/** Adapted from the pinned portal: elapsed time is never replacement evidence; use the account's mined nonce. */
async function findNonceBlock(
  client: SourceTransactionClient,
  transaction: SourceTransaction
): Promise<bigint | undefined> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const countAt = (blockNumber: bigint) => client.getTransactionCount({ address: transaction.from, blockNumber });
  if ((await countAt(head)) <= transaction.nonce) return undefined;
  let low = head;
  let high = head;
  for (let distance = 1n; low > 0n; distance *= 2n) {
    low = head > distance ? head - distance : 0n;
    if ((await countAt(low)) <= transaction.nonce) break;
    high = low;
  }
  while (low < high) {
    const middle = (low + high) / 2n;
    if ((await countAt(middle)) > transaction.nonce) high = middle;
    else low = middle + 1n;
  }
  return low;
}

export async function recoverSourceTransaction(
  client: SourceTransactionClient,
  chainId: number,
  hash: Hash,
  saved?: SourceTransaction
): Promise<SourceTransactionResolution> {
  let transaction: SourceTransaction | undefined;
  try {
    if (saved) {
      const parsed = parseSourceTransaction(saved);
      if (parsed.chainId !== chainId || parsed.hash.toLowerCase() !== hash.toLowerCase()) return { uncertain: true };
      transaction = parsed;
    }
    const original = await getTransaction(client, hash);
    if (original) {
      const captured = parseSourceTransaction({ ...original, chainId, value: original.value.toString() });
      if (
        captured.hash.toLowerCase() !== hash.toLowerCase() ||
        (transaction && replacementReason(transaction, captured) !== 'repriced')
      )
        throw new Error('Source transaction identity changed');
      transaction = captured;
    }
    if (!transaction) return {};
    if (original && original.blockNumber !== null) return { transaction };
    const blockNumber = await findNonceBlock(client, transaction);
    if (blockNumber === undefined) return { transaction };
    const block = await client.getBlock({ blockNumber, includeTransactions: true });
    const expected = transaction;
    const found = block.transactions.find(
      tx => tx.from.toLowerCase() === expected.from.toLowerCase() && tx.nonce === expected.nonce
    );
    if (!found) throw new Error('Source replacement not available');
    const replacement = parseSourceTransaction({ ...found, chainId, value: found.value.toString() });
    if (replacement.hash.toLowerCase() === hash.toLowerCase()) return { transaction };
    return {
      transaction,
      replacement,
      reason: replacementReason(transaction, replacement),
      timestamp: Number(block.timestamp) * 1000
    };
  } catch {
    return { ...(transaction && { transaction }), uncertain: true };
  }
}
