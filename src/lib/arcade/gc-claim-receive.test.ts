import type { TxAssetView } from 'app/confirm/decode';
import { ITransactionStatus, Transaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { resolveSpendsUsd } from 'lib/miden/spending-limits/valuation';

import type { GcClaimContext } from './gc-claim-operation';
import { gcReceiptPending, queueGcReceipt, verifyGcReceiptEffects } from './gc-claim-receive';

jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: async () => undefined }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (input: string) => ({ toString: () => input.split('_')[0]!.toLowerCase() }),
  canonicalWalletAccountId: (input: string) => input.split('_')[0]!.toLowerCase()
}));
jest.mock('lib/miden/spending-limits/valuation', () => ({ resolveSpendsUsd: jest.fn() }));
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: `0x${'aa'.repeat(32)}`,
  accountId: `0x${'11'.repeat(15)}`,
  issuerId: `0x${'22'.repeat(15)}`,
  nativeAssetId: `0x${'33'.repeat(15)}`,
  issuerCodeCommitment: `0x${'bb'.repeat(32)}`
};
const RECEIPT = `0x${'cc'.repeat(32)}`;
const goodView = (): TxAssetView => ({
  account: context.accountId,
  incoming: [
    { faucetId: context.issuerId, amount: 10_000_000n },
    { faucetId: context.nativeAssetId, amount: 25n }
  ],
  outgoing: [],
  fee: { faucetId: context.nativeAssetId, amount: 3n },
  inputNotesConsumed: 1,
  outputNotesCreated: 0,
  storageChanged: false
});
it('accepts exactly the approved GC and refund with only a native fee', () => {
  expect(verifyGcReceiptEffects(context, goodView(), 25n)).toBe(3n);
});
it.each(['gc', 'refund', 'outgoing', 'storage', 'input', 'output', 'account', 'fee'])(
  'rejects a receipt dry-run with changed %s',
  fault => {
    const view = goodView();
    if (fault === 'gc') view.incoming[0]!.amount--;
    if (fault === 'refund') view.incoming[1]!.amount++;
    if (fault === 'outgoing') view.outgoing.push({ faucetId: context.nativeAssetId, amount: 1n });
    if (fault === 'storage') view.storageChanged = true;
    if (fault === 'input') view.inputNotesConsumed = 2;
    if (fault === 'output') view.outputNotesCreated = 1;
    if (fault === 'account') view.account = context.issuerId;
    if (fault === 'fee') view.fee = { faucetId: context.issuerId, amount: 3n };
    expect(() => verifyGcReceiptEffects(context, view, 25n)).toThrow();
  }
);
it('atomically admits only one ordinary receipt consume, preserving exact bytes and fee accounting', async () => {
  await Repo.spendingLimits.put({
    accountId: context.accountId,
    limit: '10000',
    revision: 'r1',
    createdAt: 1,
    updatedAt: 1
  });
  jest.mocked(resolveSpendsUsd).mockResolvedValue(3n);
  await Promise.all(
    Array.from({ length: 4 }, () => queueGcReceipt(context, RECEIPT, new Uint8Array([5]), 3n, Date.now() / 1000 + 300))
  );
  const rows = await Repo.transactions.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    type: 'execute',
    inputNoteIds: [RECEIPT],
    heldNoteIds: [RECEIPT],
    noteIds: [RECEIPT],
    requestBytes: new Uint8Array([5]),
    spentAssetTotals: [{ faucetId: context.nativeAssetId, amount: 3n }],
    spentUsd: 3n
  });
  expect(await gcReceiptPending(context, RECEIPT)).toBe(true);
});
it('blocks an ordinary existing holder and ambiguous failed rows, including after restart', async () => {
  const row = new Transaction(context.accountId, new Uint8Array([1]), [RECEIPT]);
  row.heldNoteIds = [RECEIPT];
  row.status = ITransactionStatus.Failed;
  await Repo.transactions.put(row);
  await queueGcReceipt(context, RECEIPT, new Uint8Array([5]), 3n, Date.now() / 1000 + 300);
  expect(await Repo.transactions.count()).toBe(1);
  expect(await gcReceiptPending(context, RECEIPT)).toBe(true);
});
it('rejects expired admission without storing any work', async () => {
  await expect(queueGcReceipt(context, RECEIPT, new Uint8Array([5]), 3n, Date.now() / 1000 - 1)).rejects.toThrow(
    'expired'
  );
  expect(await Repo.transactions.count()).toBe(0);
});
it('renews once only after the node proved the previous consume never committed', async () => {
  await queueGcReceipt(context, RECEIPT, new Uint8Array([5]), 3n, Date.now() / 1000 + 300);
  const row = (await Repo.transactions.toArray())[0]!;
  await Repo.transactions.update(row.id, {
    status: ITransactionStatus.Failed,
    neverCommittedAt: Date.now() / 1000,
    submitEvidence: [
      {
        attemptId: 'failed',
        source: 'pin',
        capturedAt: Date.now() / 1000,
        transactionId: context.genesisCommitment,
        initialCommitment: context.genesisCommitment,
        finalCommitment: context.issuerCodeCommitment,
        initialNonce: '1',
        outputNoteIds: [],
        nullifiers: [RECEIPT],
        refBlock: 1,
        refBlockCommitment: context.genesisCommitment,
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  expect(await gcReceiptPending(context, RECEIPT)).toBe(false);
  await Promise.all(
    [1, 2, 3].map(() => queueGcReceipt(context, RECEIPT, new Uint8Array([6]), 3n, Date.now() / 1000 + 300))
  );
  const rows = await Repo.transactions.toArray();
  expect(rows).toHaveLength(2);
  expect(rows.filter(item => item.status === ITransactionStatus.Queued)).toHaveLength(1);
  expect((await Repo.transactions.get(row.id))?.requestBytes).toEqual(new Uint8Array([5]));
});
