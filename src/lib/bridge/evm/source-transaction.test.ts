import { TransactionNotFoundError } from 'viem';

import {
  captureSourceTransaction,
  parseSourceTransaction,
  recoverSourceTransaction,
  replacementReason,
  type SourceTransaction,
  type SourceTransactionClient
} from './source-transaction';

const original: SourceTransaction = {
  chainId: 11155111,
  hash: `0x${'1'.repeat(64)}`,
  from: `0x${'2'.repeat(40)}`,
  nonce: 7,
  to: `0x${'3'.repeat(40)}`,
  input: '0x1234',
  value: '100'
};
const replacement: SourceTransaction = { ...original, hash: `0x${'4'.repeat(64)}` };
const rpc = (tx: SourceTransaction, blockNumber: bigint | null = null) => ({
  ...tx,
  value: BigInt(tx.value),
  blockNumber
});
function client(): SourceTransactionClient {
  return {
    getTransaction: jest.fn(async () => rpc(original)),
    getBlockNumber: jest.fn(async () => 10n),
    getTransactionCount: jest.fn(async ({ blockNumber }) => (blockNumber >= 8n ? 8 : 7)),
    getBlock: jest.fn(async () => ({ timestamp: 123n, transactions: [rpc(replacement, 8n)] }))
  };
}

it('captures the actual wallet nonce and complete source call without guessing fees or a nonce', async () => {
  expect(await captureSourceTransaction(client(), original.chainId, original.hash)).toEqual(original);
});

it.each([
  { nonce: -1 },
  { nonce: 1.5 },
  { chainId: 0 },
  { hash: '0x12' },
  { from: 'not-address' },
  { to: '0x00' },
  { input: '0x1' },
  { value: '-1' }
])('refuses malformed recovery identity %j', change => {
  expect(() => parseSourceTransaction({ ...original, ...change })).toThrow();
});

it('permits contract creation identity but does not reinterpret it as a token call', () => {
  expect(parseSourceTransaction({ ...original, to: null })).toEqual({ ...original, to: null });
});

it.each([
  [{}, 'repriced'],
  [{ to: original.from, input: '0x', value: '0' }, 'cancelled'],
  [{ input: '0xabcd' }, 'replaced'],
  [{ value: '101' }, 'replaced'],
  [{ to: `0x${'5'.repeat(40)}` }, 'replaced']
] satisfies Array<[Partial<SourceTransaction>, string]>)(
  'classifies replacement from its actual call %j',
  (change, want) => {
    expect(replacementReason(original, { ...replacement, ...change })).toBe(want);
  }
);

it.each([{ chainId: 1 }, { nonce: 8 }, { from: `0x${'5'.repeat(40)}` }] satisfies Partial<SourceTransaction>[])(
  'does not adopt a transaction from another source identity %j',
  change => expect(() => replacementReason(original, { ...replacement, ...change })).toThrow()
);

it('finds a mined replacement by account nonce and retains the original lineage', async () => {
  const read = client();
  jest.mocked(read.getTransaction).mockRejectedValue(new TransactionNotFoundError({ hash: original.hash }));
  const result = await recoverSourceTransaction(read, original.chainId, original.hash, original);
  expect(result).toEqual({ transaction: original, replacement, reason: 'repriced', timestamp: 123000 });
  expect(read.getBlock).toHaveBeenCalledWith({ blockNumber: 8n, includeTransactions: true });
});

it('elapsed time and a missing hash never prove cancellation', async () => {
  const read = client();
  jest.mocked(read.getTransaction).mockRejectedValue(new TransactionNotFoundError({ hash: original.hash }));
  jest.mocked(read.getTransactionCount).mockResolvedValue(7);
  expect(await recoverSourceTransaction(read, original.chainId, original.hash, original)).toEqual({
    transaction: original
  });
  expect(read.getBlock).not.toHaveBeenCalled();
});

it('preserves verified identity through an RPC outage without inventing a replacement', async () => {
  const read = client();
  jest.mocked(read.getTransaction).mockRejectedValue(new Error('offline'));
  expect(await recoverSourceTransaction(read, original.chainId, original.hash, original)).toEqual({
    transaction: original,
    uncertain: true
  });
});

it('does not search a nonce when no original identity is known or its chain/hash differs', async () => {
  const read = client();
  jest.mocked(read.getTransaction).mockRejectedValue(new TransactionNotFoundError({ hash: original.hash }));
  expect(await recoverSourceTransaction(read, original.chainId, original.hash)).toEqual({});
  expect(await recoverSourceTransaction(read, 1, original.hash, original)).toEqual({ uncertain: true });
  expect(read.getTransactionCount).not.toHaveBeenCalled();
});
