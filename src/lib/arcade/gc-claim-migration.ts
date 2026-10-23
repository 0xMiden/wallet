import type { ArcadeAccountScope, WeeklyClaimService, WeeklyClaimSnapshot } from './weekly-claim';

function needsLegacyCleanup(snapshot: WeeklyClaimSnapshot): boolean {
  return (
    snapshot.pendingOperations === true ||
    (snapshot.recoveries?.length ?? 0) > 0 ||
    (snapshot.receipts?.length ?? 0) > 0 ||
    ['checking', 'unavailable', 'pending', 'receivable', 'reclaimable'].includes(snapshot.status.kind)
  );
}

/** Drain prior deployment funds before new claims; approvals stay with their original authority. */
export function createGcClaimMigrationService(
  active: WeeklyClaimService,
  legacy: WeeklyClaimService
): WeeklyClaimService {
  const approvals = new Map<string, WeeklyClaimService>();
  async function inspect(scope: ArcadeAccountScope) {
    const snapshot = await legacy.read(scope);
    return needsLegacyCleanup(snapshot) ? { service: legacy, snapshot } : { service: active };
  }
  return {
    async read(scope) {
      const selected = await inspect(scope);
      return selected.snapshot ?? selected.service.read(scope);
    },
    async prepare(scope, operationId) {
      const selected = await inspect(scope);
      const quote = await selected.service.prepare(scope, operationId);
      if (selected.service === legacy && quote.mode === 'claim') throw new Error('Legacy GC claims are disabled');
      if (approvals.has(quote.quoteId)) throw new Error('GC approval identity collision');
      approvals.set(quote.quoteId, selected.service);
      return quote;
    },
    async submit(scope, quoteId) {
      const service = approvals.get(quoteId);
      if (!service) throw new Error('GC approval unavailable');
      return service.submit(scope, quoteId);
    }
  };
}
