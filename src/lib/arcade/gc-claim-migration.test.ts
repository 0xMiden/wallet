import { createGcClaimMigrationService } from './gc-claim-migration';
import type { WeeklyClaimService, WeeklyClaimSnapshot } from './weekly-claim';

const scope = { networkId: 'testnet', accountId: 'account' };
function service(
  label: string,
  snapshot: WeeklyClaimSnapshot,
  mode: 'claim' | 'receive' | 'reclaim'
): WeeklyClaimService {
  const quoteId = `${label}-quote`;
  return {
    read: async () => snapshot,
    prepare: async () => ({
      quoteId,
      mode,
      allocationWeekStart: '2026-10-19T00:00:00.000Z',
      expiresAt: '2026-10-23T04:00:00.000Z',
      nativeSymbol: 'USDCX',
      requestFee: '0.000133',
      issuerBudget: '0.00021',
      receiptFeeBudget: '0.00021'
    }),
    submit: async (_scope, supplied) => {
      if (supplied !== quoteId) throw new Error('Wrong approval backend');
      return { status: { kind: 'pending' }, balance: label };
    }
  };
}
const active = () => service('active', { status: { kind: 'eligible' }, balance: '20' }, 'claim');
it.each(['eligible', 'failed', 'claimed'] as const)('uses v2 after legacy %s with no unfinished funds', async kind => {
  const status = kind === 'claimed' ? { kind, nextEligibleAt: '2026-10-26T00:00:00Z' } : { kind };
  const coordinator = createGcClaimMigrationService(active(), service('legacy', { status, balance: '10' }, 'claim'));
  expect(await coordinator.read(scope)).toEqual({ status: { kind: 'eligible' }, balance: '20' });
  expect((await coordinator.prepare(scope)).quoteId).toBe('active-quote');
});
it.each([
  { status: { kind: 'reclaimable', reclaimHeight: 100 } },
  { status: { kind: 'receivable' } },
  { status: { kind: 'pending' } },
  { status: { kind: 'checking' } },
  { status: { kind: 'unavailable' } },
  { status: { kind: 'claimed', nextEligibleAt: '2026-10-26T00:00:00Z' }, pendingOperations: true },
  { status: { kind: 'eligible' }, recoveries: [{ operationId: 'old', allocationWeekStart: '2026-10-12T00:00:00Z' }] },
  { status: { kind: 'eligible' }, receipts: [{ operationId: 'old', allocationWeekStart: '2026-10-12T00:00:00Z' }] }
] satisfies Partial<WeeklyClaimSnapshot>[])('keeps legacy cleanup visible: %j', async partial => {
  const snapshot: WeeklyClaimSnapshot = { balance: '10', ...partial };
  const coordinator = createGcClaimMigrationService(active(), service('legacy', snapshot, 'reclaim'));
  expect(await coordinator.read(scope)).toEqual(snapshot);
});
it('submits a legacy cleanup approval to its original backend after cleanup status changes', async () => {
  const snapshot: WeeklyClaimSnapshot = { balance: '10', status: { kind: 'reclaimable', reclaimHeight: 100 } };
  const coordinator = createGcClaimMigrationService(active(), service('legacy', snapshot, 'reclaim'));
  const quote = await coordinator.prepare(scope, 'old-request');
  snapshot.status = { kind: 'eligible' };
  expect((await coordinator.read(scope)).balance).toBe('20');
  expect(await coordinator.submit(scope, quote.quoteId)).toEqual({ status: { kind: 'pending' }, balance: 'legacy' });
  expect(await coordinator.submit(scope, quote.quoteId)).toEqual({ status: { kind: 'pending' }, balance: 'legacy' });
});
it('refuses a new legacy claim if its recovery disappears during preparation', async () => {
  const legacy = service('legacy', { balance: '10', status: { kind: 'reclaimable', reclaimHeight: 100 } }, 'claim');
  const coordinator = createGcClaimMigrationService(active(), legacy);
  await expect(coordinator.prepare(scope)).rejects.toThrow('Legacy GC claims are disabled');
  await expect(coordinator.submit(scope, 'unknown')).rejects.toThrow();
});
