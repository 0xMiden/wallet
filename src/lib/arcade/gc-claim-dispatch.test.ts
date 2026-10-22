import type { GcClaimContext, PreparedGcClaim } from './gc-claim-operation';
import { queueGcClaimRequest } from './gc-claim-service';

const mockQueue = jest.fn();
const mockWake = jest.fn(async () => undefined);
jest.mock('./gc-claim-queue', () => ({
  listGcClaimOperations: async () => [],
  queuePreparedGcClaim: (...args: unknown[]) => mockQueue(...args)
}));
jest.mock('lib/miden/back/transaction-processor', () => ({ startTransactionProcessing: () => mockWake() }));
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: 'genesis',
  accountId: 'account',
  issuerId: 'issuer',
  issuerCodeCommitment: 'code',
  nativeAssetId: 'native'
};
const prepared: PreparedGcClaim = {
  scope: { ...context, approvedWeek: 1 },
  issuerCodeCommitment: 'code',
  nativeAssetId: 'native',
  requestNoteId: 'note',
  receiptRecipientCommitment: 'receipt',
  nativeBudget: 30n,
  outgoingNativeAmount: 35n,
  approvalExpiresAt: 1000,
  reclaimHeight: 100,
  requestBytes: new Uint8Array([1])
};
beforeEach(() => jest.clearAllMocks());
it('wakes the existing processor only after the approved claim is durably queued', async () => {
  let commit = () => {};
  mockQueue.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        commit = resolve;
      })
  );
  const queued = queueGcClaimRequest(context, prepared);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mockQueue).toHaveBeenCalledTimes(1);
  expect(mockWake).not.toHaveBeenCalled();
  commit();
  await queued;
  expect(mockWake).toHaveBeenCalledTimes(1);
});
it('does not wake or dispatch when durable queue admission fails', async () => {
  mockQueue.mockRejectedValueOnce(new Error('storage failed'));
  await expect(queueGcClaimRequest(context, prepared)).rejects.toThrow('storage');
  expect(mockWake).not.toHaveBeenCalled();
});
