import type { ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';

import type { GcClaimDeployment } from './gc-claim-deployment';
import type { GcClaimIssuanceEvidence, PreparedGcClaim } from './gc-claim-operation';
import type { GcClaimReconciliation } from './gc-claim-reconcile';
import {
  createGcClaimBackendService,
  GcBalanceAwaitingSyncError,
  type GcClaimServiceDependencies
} from './gc-claim-service';

const w = (digit: string) => `0x${digit.repeat(64)}`;
const scope = { accountId: 'account', networkId: 'testnet' };
const deployment: GcClaimDeployment = {
  network: 'testnet',
  genesisCommitment: w('1'),
  issuerId: 'issuer',
  issuerCodeCommitment: w('2'),
  nativeAssetId: 'native',
  claimScriptRoot: w('3'),
  claimScriptBytes: new Uint8Array([1]),
  deploymentBlock: 1,
  reclaimDelayBlocks: 100,
  nativeSymbol: 'MIDEN',
  nativeDecimals: 6
};
const entitlement = {
  approvedWeek: 1,
  claimed: false,
  referenceBlock: 10,
  referenceTimestamp: 400000,
  verificationBaseFee: 1,
  nextEligibleAt: '1970-01-12T00:00:00Z'
};
const prepared: PreparedGcClaim = {
  scope: { genesisCommitment: w('1'), accountId: 'account', issuerId: 'issuer', approvedWeek: 1 },
  issuerCodeCommitment: w('2'),
  nativeAssetId: 'native',
  requestNoteId: w('4'),
  receiptRecipientCommitment: w('5'),
  nativeBudget: 30n,
  outgoingNativeAmount: 35n,
  approvalExpiresAt: 400300,
  reclaimHeight: 110,
  requestBytes: new Uint8Array([8, 9])
};
const deps = (): GcClaimServiceDependencies => ({
  activeScope: jest.fn(async () => scope),
  deployment: jest.fn(async () => deployment),
  normalizeContext: jest.fn(async context => context),
  entitlement: jest.fn(async () => entitlement),
  balances: jest.fn(async () => ({ gc: 50_000_000n, native: 100n })),
  operations: jest.fn(async () => []),
  history: jest.fn(async () => ({
    requests: [],
    unrecognizedRequestIds: [],
    complete: true,
    cursor: { nextBlock: 11, tipBlock: 10, tipCommitment: w('6') }
  })),
  restoreHistory: jest.fn(async () => undefined),
  phase: () => 'pending',
  reconcile: jest.fn(async (): Promise<GcClaimReconciliation> => ({ state: 'pending', evidence: [] })),
  recordEvidence: jest.fn(async () => undefined),
  prepareClaim: jest.fn(async () => ({ prepared, requestFee: 5n, receiptFeeBudget: 30n })),
  receiptPending: jest.fn(async () => false),
  prepareReceive: jest.fn(async () => ({ requestBytes: new Uint8Array([6]), requestFee: 3n })),
  queueReceive: jest.fn(async () => undefined),
  prepareReclaim: jest.fn(async () => ({ requestBytes: new Uint8Array([7]), requestFee: 2n })),
  queueClaim: jest.fn(async () => undefined),
  queueReclaim: jest.fn(async () => undefined),
  now: () => 400000,
  quoteId: () => 'quote-1'
});

it('keeps missing pinned configuration unavailable and never builds or queues', async () => {
  const d = deps();
  d.deployment = async () => undefined;
  const service = createGcClaimBackendService(d);
  await expect(service.read(scope)).resolves.toEqual({ status: { kind: 'unavailable' }, balance: null });
  await expect(service.prepare(scope)).rejects.toThrow();
  expect(d.prepareClaim).not.toHaveBeenCalled();
  expect(d.queueClaim).not.toHaveBeenCalled();
});
it('prepares a sanitized quote and dispatches only its exact immutable captured bytes', async () => {
  const d = deps();
  const service = createGcClaimBackendService(d);
  const quote = await service.prepare(scope);
  expect(quote).toEqual({
    quoteId: 'quote-1',
    mode: 'claim',
    allocationWeekStart: '1970-01-05T00:00:00.000Z',
    expiresAt: '1970-01-05T15:11:40.000Z',
    nativeSymbol: 'MIDEN',
    requestFee: '0.000005',
    issuerBudget: '0.00003',
    receiptFeeBudget: '0.00003'
  });
  expect(d.queueClaim).not.toHaveBeenCalled();
  await expect(service.submit(scope, quote.quoteId)).resolves.toMatchObject({ status: { kind: 'pending' } });
  expect(d.queueClaim).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ requestBytes: new Uint8Array([8, 9]) })
  );
  await service.submit(scope, quote.quoteId);
  expect(d.queueClaim).toHaveBeenCalledTimes(1);
});
it.each(['account', 'network', 'deployment', 'week', 'expired'])('refuses changed %s before dispatch', async change => {
  const d = deps();
  const service = createGcClaimBackendService(d);
  const quote = await service.prepare(scope);
  if (change === 'account') d.activeScope = async () => ({ ...scope, accountId: 'other' });
  if (change === 'network') d.activeScope = async () => ({ ...scope, networkId: 'mainnet' });
  if (change === 'deployment') d.deployment = async () => ({ ...deployment, issuerCodeCommitment: w('7') });
  if (change === 'week') d.entitlement = async () => ({ ...entitlement, approvedWeek: 2 });
  if (change === 'expired') d.now = () => 400300;
  await expect(service.submit(scope, quote.quoteId)).resolves.toMatchObject({ status: { kind: 'failed' } });
  expect(d.queueClaim).not.toHaveBeenCalled();
});
it('fails closed on unread balances, entitlement, incomplete history or recovered unknown requests', async () => {
  for (const fault of ['balance', 'entitlement', 'history', 'request']) {
    const d = deps();
    if (fault === 'balance')
      d.balances = async () => {
        throw new Error('offline');
      };
    if (fault === 'entitlement')
      d.entitlement = async () => {
        throw new Error('offline');
      };
    if (fault === 'history')
      d.history = async () => ({
        requests: [],
        unrecognizedRequestIds: [],
        complete: false,
        cursor: { nextBlock: 2, tipBlock: 10, tipCommitment: w('6') }
      });
    if (fault === 'request')
      d.history = async () => ({
        requests: [],
        unrecognizedRequestIds: [w('8')],
        complete: true,
        cursor: { nextBlock: 11, tipBlock: 10, tipCommitment: w('6') }
      });
    const service = createGcClaimBackendService(d);
    await expect(service.prepare(scope)).rejects.toThrow();
    expect(d.queueClaim).not.toHaveBeenCalled();
  }
});
it('requires enough native balance for request, issuer budget and receipt reserve', async () => {
  const d = deps();
  d.balances = async () => ({ gc: 0n, native: 64n });
  await expect(createGcClaimBackendService(d).prepare(scope)).rejects.toThrow('native');
  expect(d.queueClaim).not.toHaveBeenCalled();
});
it('does not equate entitlement consumed or request completed with delivery', async () => {
  const d = deps();
  d.entitlement = async () => ({ ...entitlement, claimed: true });
  await expect(createGcClaimBackendService(d).read(scope)).resolves.toMatchObject({ status: { kind: 'pending' } });
});
it('reports incomplete history as checking, then releases an unclaimed week after the scan completes', async () => {
  const d = deps();
  let complete = false;
  d.history = async () => ({
    requests: [],
    unrecognizedRequestIds: [],
    complete,
    cursor: { nextBlock: complete ? 211 : 129, tipBlock: 210, tipCommitment: w('6') }
  });
  const service = createGcClaimBackendService(d);
  expect((await service.read(scope)).status.kind).toBe('checking');
  complete = true;
  expect((await service.read(scope)).status.kind).toBe('eligible');
});
it('keeps a background-sync balance wait retryable without exposing a stale balance', async () => {
  const d = deps();
  let syncing = true;
  d.balances = async () => {
    if (syncing) throw new GcBalanceAwaitingSyncError();
    return { gc: 10_000_000n, native: 100n };
  };
  const service = createGcClaimBackendService(d);
  await expect(service.read(scope)).resolves.toEqual({ status: { kind: 'checking' }, balance: null });
  syncing = false;
  expect((await service.read(scope)).balance).toBe('10');
});
it('stops automatic checking when an unknown public request blocks complete history', async () => {
  const d = deps();
  d.history = async () => ({
    requests: [],
    unrecognizedRequestIds: [w('8')],
    complete: true,
    cursor: { nextBlock: 211, tipBlock: 210, tipCommitment: w('6') }
  });
  const service = createGcClaimBackendService(d);
  expect((await service.read(scope)).status.kind).toBe('unavailable');
  await expect(service.prepare(scope)).rejects.toThrow();
});
it('prepares and queues recovery of the same authenticated request only after explicit approval', async () => {
  const d = deps();
  const row: ITransaction = {
    id: 'operation',
    type: 'execute',
    accountId: scope.accountId,
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    gcClaim: { ...prepared, version: 1 }
  };
  d.operations = async () => [row];
  d.reconcile = async () => ({ state: 'reclaimable', evidence: [], requestNoteBytes: new Uint8Array([3]) });
  const service = createGcClaimBackendService(d);
  const quote = await service.prepare(scope);
  expect(quote.mode).toBe('reclaim');
  expect(quote.issuerBudget).toBe('0.00003');
  expect(quote.receiptFeeBudget).toBe('0');
  expect(d.queueReclaim).not.toHaveBeenCalled();
  await service.submit(scope, quote.quoteId);
  expect(d.queueReclaim).toHaveBeenCalledWith(expect.anything(), row, new Uint8Array([7]), 2n, 400300);
  expect(d.queueClaim).not.toHaveBeenCalled();
});

it('restores recovered chain requests before reconciling them and keeps completed scan progress', async () => {
  const d = deps();
  const row: ITransaction = {
    id: 'recovered',
    type: 'execute',
    accountId: scope.accountId,
    status: ITransactionStatus.Unconfirmed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    gcClaim: { ...prepared, version: 1 }
  };
  const cursor = { nextBlock: 11, tipBlock: 10, tipCommitment: w('6') };
  d.history = jest.fn(async () => ({
    requests: [{ material: prepared, noteBytes: new Uint8Array([3]), inclusionBlock: 10 }],
    unrecognizedRequestIds: [],
    complete: true,
    cursor
  }));
  d.restoreHistory = jest.fn(async () => {
    d.operations = async () => [row];
  });
  d.reconcile = async () => ({ state: 'reclaimable', evidence: [], requestNoteBytes: new Uint8Array([3]) });
  const service = createGcClaimBackendService(d);
  await expect(service.read(scope)).resolves.toMatchObject({ status: { kind: 'reclaimable' } });
  expect(d.restoreHistory).toHaveBeenCalledTimes(1);
  d.operations = async () => [];
  await service.read(scope);
  expect(d.history).toHaveBeenLastCalledWith(expect.anything(), deployment, cursor);
});

it('recovers an authenticated older request without blocking a fresh Monday allowance or rebinding the old week', async () => {
  const d = deps();
  d.now = () => 1555199;
  d.entitlement = async () => ({ ...entitlement, approvedWeek: 2, referenceTimestamp: 1555199 });
  const older: ITransaction = {
    id: 'older',
    type: 'execute',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    gcClaim: { ...prepared, version: 1 }
  };
  d.operations = async () => [older];
  d.reconcile = async () => ({ state: 'reclaimable', evidence: [], requestNoteBytes: new Uint8Array([3]) });
  const service = createGcClaimBackendService(d);
  const before = await service.read(scope);
  expect(before.status.kind).toBe('eligible');
  expect(before.recoveries).toEqual([{ operationId: 'older', allocationWeekStart: '1970-01-05T00:00:00.000Z' }]);
  const quote = await service.prepare(scope, 'older');
  expect(quote.mode).toBe('reclaim');
  expect(quote.allocationWeekStart).toBe('1970-01-05T00:00:00.000Z');
  d.now = () => 1555200;
  d.entitlement = async () => ({ ...entitlement, approvedWeek: 3, referenceTimestamp: 1555200 });
  const after = await service.submit(scope, quote.quoteId);
  expect(after.status.kind).toBe('eligible');
  expect(after.allocationWeekStart).toBe('1970-01-19T00:00:00.000Z');
  expect(after.recoveries).toEqual([]);
  expect(d.queueClaim).not.toHaveBeenCalled();
  expect(d.queueReclaim).toHaveBeenCalledTimes(1);
});

it('refuses a target outside the authenticated recovery inventory', async () => {
  const d = deps();
  await expect(createGcClaimBackendService(d).prepare(scope, 'someone-elses-operation')).rejects.toThrow('unavailable');
  expect(d.queueReclaim).not.toHaveBeenCalled();
});

it('does not let an unread older recovery suppress the current weekly entitlement', async () => {
  const d = deps();
  d.entitlement = async () => ({ ...entitlement, approvedWeek: 2 });
  d.operations = async () => [
    {
      id: 'older',
      type: 'execute',
      accountId: 'account',
      status: ITransactionStatus.Unconfirmed,
      initiatedAt: 1,
      displayIcon: 'DEFAULT',
      gcClaim: { ...prepared, version: 1 }
    }
  ];
  d.reconcile = async () => {
    throw new Error('older note read failed');
  };
  expect((await createGcClaimBackendService(d).read(scope)).status.kind).toBe('eligible');
});

it('rejects a quote expired by fresh chain time even when the device clock is behind', async () => {
  const d = deps();
  const service = createGcClaimBackendService(d);
  const quote = await service.prepare(scope);
  d.entitlement = async () => ({ ...entitlement, referenceTimestamp: 400301 });
  await expect(service.submit(scope, quote.quoteId)).resolves.toMatchObject({ status: { kind: 'failed' } });
  expect(d.queueClaim).not.toHaveBeenCalled();
});

it('reads balances after receipt reconciliation, so claimed never carries a pre-consume vault snapshot', async () => {
  const d = deps();
  const order: string[] = [];
  d.operations = async () => [
    {
      id: 'own',
      type: 'execute',
      accountId: 'account',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'DEFAULT',
      gcClaim: { ...prepared, version: 1 }
    }
  ];
  d.reconcile = async () => {
    order.push('reconciled');
    return { state: 'delivered', evidence: [] };
  };
  d.balances = async () => {
    order.push('balances');
    return { gc: order.includes('reconciled') ? 60_000_000n : 50_000_000n, native: 100n };
  };
  expect(await createGcClaimBackendService(d).read(scope)).toMatchObject({
    status: { kind: 'claimed' },
    balance: '60'
  });
  expect(order).toEqual(['reconciled', 'balances']);
});

it('keeps an ambiguous queue rejection pending and preserves that result on replay', async () => {
  const d = deps();
  d.queueClaim = jest.fn(async () => {
    throw new Error('unknown after insert');
  });
  const service = createGcClaimBackendService(d);
  const quote = await service.prepare(scope);
  expect((await service.submit(scope, quote.quoteId)).status.kind).toBe('pending');
  expect((await service.submit(scope, quote.quoteId)).status.kind).toBe('pending');
  expect(d.queueClaim).toHaveBeenCalledTimes(1);
});

it('missing backend quote state remains uncertain rather than reporting non-submission', async () => {
  await expect(createGcClaimBackendService(deps()).submit(scope, 'missing-after-restart')).rejects.toThrow(
    'unavailable'
  );
});

function issuedDependencies() {
  const d = deps();
  const issuance: GcClaimIssuanceEvidence = {
    kind: 'issued',
    genesisCommitment: w('1'),
    blockNumber: 10,
    blockCommitment: w('6'),
    accountId: scope.accountId,
    requestNoteId: prepared.requestNoteId,
    requestNullifier: w('7'),
    issuerId: deployment.issuerId,
    receiptNoteId: w('8'),
    receiptRecipientCommitment: prepared.receiptRecipientCommitment,
    gcAmount: 10_000_000n,
    nativeRefund: 25n,
    issuerFee: 5n
  };
  const row: ITransaction = {
    id: 'issued-operation',
    type: 'execute',
    accountId: scope.accountId,
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    gcClaim: { ...prepared, version: 1, issuance }
  };
  d.operations = async () => [row];
  d.reconcile = async () => ({ state: 'issued', evidence: [issuance], receiptNoteBytes: new Uint8Array([9]) });
  return { d, row, issuance };
}
it('offers an authenticated receipt, reviews its exact consume fee, and queues only after confirmation', async () => {
  const { d, row, issuance } = issuedDependencies();
  const service = createGcClaimBackendService(d);
  expect((await service.read(scope)).status.kind).toBe('receivable');
  const quote = await service.prepare(scope);
  expect(quote).toMatchObject({ mode: 'receive', requestFee: '0.000003', nativeRefund: '0.000025' });
  expect(d.prepareReceive).toHaveBeenCalledWith(expect.anything(), row, issuance, new Uint8Array([9]));
  expect(d.queueReceive).not.toHaveBeenCalled();
  await service.submit(scope, quote.quoteId);
  expect(d.queueReceive).toHaveBeenCalledWith(
    expect.anything(),
    issuance.receiptNoteId,
    new Uint8Array([6]),
    3n,
    400300
  );
  await service.submit(scope, quote.quoteId);
  expect(d.queueReceive).toHaveBeenCalledTimes(1);
  expect(d.queueClaim).not.toHaveBeenCalled();
});
it('withholds receipt acceptance without authenticated bytes or while an ordinary consume holds it', async () => {
  const { d } = issuedDependencies();
  d.reconcile = async () => ({ state: 'issued', evidence: [] });
  expect((await createGcClaimBackendService(d).read(scope)).status.kind).toBe('pending');
  const { d: held } = issuedDependencies();
  held.receiptPending = async () => true;
  const service = createGcClaimBackendService(held);
  expect((await service.read(scope)).status.kind).toBe('pending');
  await expect(service.prepare(scope)).rejects.toThrow();
  expect(held.queueReceive).not.toHaveBeenCalled();
});
it('keeps an older receipt independently actionable after the new week opens', async () => {
  const { d } = issuedDependencies();
  d.entitlement = async () => ({ ...entitlement, approvedWeek: 2 });
  const service = createGcClaimBackendService(d);
  const before = await service.read(scope);
  expect(before.status.kind).toBe('eligible');
  expect(before.receipts).toEqual([
    { operationId: 'issued-operation', allocationWeekStart: '1970-01-05T00:00:00.000Z' }
  ]);
  const quote = await service.prepare(scope, 'issued-operation');
  expect(quote.mode).toBe('receive');
  const after = await service.submit(scope, quote.quoteId);
  expect(after.status.kind).toBe('eligible');
  expect(after.receipts).toEqual([]);
});
it('rechecks the exact receipt and its fee funding before admitting a reviewed consume', async () => {
  const { d } = issuedDependencies();
  d.balances = async () => ({ gc: 0n, native: 0n });
  d.prepareReceive = jest.fn(async () => ({ requestBytes: new Uint8Array([6]), requestFee: 26n }));
  await expect(createGcClaimBackendService(d).prepare(scope)).rejects.toThrow('native');
  expect(d.queueReceive).not.toHaveBeenCalled();
  const { d: raced } = issuedDependencies();
  const service = createGcClaimBackendService(raced);
  const quote = await service.prepare(scope);
  raced.receiptPending = async () => true;
  await service.submit(scope, quote.quoteId);
  expect(raced.queueReceive).not.toHaveBeenCalled();
});

it('keeps watching a duplicate pending request after another request delivered this week', async () => {
  const d = deps();
  const row: ITransaction = {
    id: 'delivered',
    type: 'execute',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    gcClaim: { ...prepared, version: 1 }
  };
  d.operations = async () => [row, { ...row, id: 'duplicate' }];
  let recoverable = false;
  d.reconcile = async (_context, operation) =>
    operation.id === 'delivered'
      ? { state: 'delivered', evidence: [] }
      : { state: recoverable ? 'reclaimable' : 'pending', evidence: [], requestNoteBytes: new Uint8Array([3]) };
  const service = createGcClaimBackendService(d);
  await expect(service.read(scope)).resolves.toMatchObject({ status: { kind: 'claimed' }, pendingOperations: true });
  recoverable = true;
  const available = await service.read(scope);
  expect(available.status.kind).toBe('reclaimable');
  expect(available).not.toHaveProperty('pendingOperations');
  expect(d.queueClaim).not.toHaveBeenCalled();
  expect(d.queueReclaim).not.toHaveBeenCalled();
});

it('finishes scanning history after finding a delivered claim so later requests remain discoverable', async () => {
  const d = deps();
  d.operations = async () => [
    {
      id: 'delivered',
      type: 'execute',
      accountId: 'account',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'DEFAULT',
      gcClaim: { ...prepared, version: 1 }
    }
  ];
  d.reconcile = async () => ({ state: 'delivered', evidence: [] });
  let complete = false;
  d.history = async () => ({
    requests: [],
    unrecognizedRequestIds: [],
    complete,
    cursor: { nextBlock: complete ? 211 : 129, tipBlock: 210, tipCommitment: w('6') }
  });
  const service = createGcClaimBackendService(d);
  await expect(service.read(scope)).resolves.toMatchObject({ status: { kind: 'claimed' }, pendingOperations: true });
  complete = true;
  expect(await service.read(scope)).not.toHaveProperty('pendingOperations');
});
