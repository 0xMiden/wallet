import type { ITransaction } from 'lib/miden/db/types';

import type { GcEntitlement } from './entitlement';
import type { GcClaimDeployment } from './gc-claim-deployment';
import { createGcClaimMigrationService } from './gc-claim-migration';
import { gcClaimAssetId, gcClaimBindingKey, gcClaimScope, gcClaimPhase as classifyPhase } from './gc-claim-operation';
import type {
  GcClaimContext,
  GcClaimEvidence,
  GcClaimIssuanceEvidence,
  GcClaimPhase,
  PreparedGcClaim
} from './gc-claim-operation';
import type { GcClaimHistoryCursor, GcClaimHistoryPage, GcClaimReconciliation } from './gc-claim-reconcile';
import type { ArcadeAccountScope, WeeklyClaimReview, WeeklyClaimService, WeeklyClaimSnapshot } from './weekly-claim';

export interface GcClaimServiceDependencies {
  activeScope(): Promise<ArcadeAccountScope>;
  deployment(): Promise<GcClaimDeployment | undefined>;
  normalizeContext(context: GcClaimContext): Promise<GcClaimContext>;
  entitlement(context: GcClaimContext): Promise<GcEntitlement>;
  balances(context: GcClaimContext, minimumBlock?: number): Promise<{ gc: bigint; native: bigint }>;
  operations(context: GcClaimContext): Promise<ITransaction[]>;
  history(
    context: GcClaimContext,
    deployment: GcClaimDeployment,
    cursor?: GcClaimHistoryCursor
  ): Promise<GcClaimHistoryPage>;
  restoreHistory(context: GcClaimContext, page: GcClaimHistoryPage): Promise<void>;
  phase(row: ITransaction): GcClaimPhase;
  reconcile(context: GcClaimContext, row: ITransaction, deployment: GcClaimDeployment): Promise<GcClaimReconciliation>;
  recordEvidence(context: GcClaimContext, id: string, evidence: GcClaimEvidence): Promise<void>;
  prepareClaim(
    context: GcClaimContext,
    deployment: GcClaimDeployment,
    entitlement: GcEntitlement
  ): Promise<{ prepared: PreparedGcClaim; requestFee: bigint; receiptFeeBudget: bigint }>;
  prepareReclaim(
    context: GcClaimContext,
    deployment: GcClaimDeployment,
    row: ITransaction,
    noteBytes: Uint8Array
  ): Promise<{ requestBytes: Uint8Array; requestFee: bigint }>;
  receiptPending(context: GcClaimContext, receiptId: string): Promise<boolean>;
  prepareReceive(
    context: GcClaimContext,
    row: ITransaction,
    issuance: GcClaimIssuanceEvidence,
    noteBytes: Uint8Array
  ): Promise<{ requestBytes: Uint8Array; requestFee: bigint }>;
  queueReceive(
    context: GcClaimContext,
    receiptId: string,
    requestBytes: Uint8Array,
    fee: bigint,
    expiresAt: number
  ): Promise<void>;
  queueClaim(context: GcClaimContext, prepared: PreparedGcClaim): Promise<void>;
  queueReclaim(
    context: GcClaimContext,
    row: ITransaction,
    requestBytes: Uint8Array,
    fee: bigint,
    expiresAt: number
  ): Promise<void>;
  now(): number;
  quoteId(): string;
}

const WEEK = 604800;
const MONDAY = 259200;
const unavailable: WeeklyClaimSnapshot = { status: { kind: 'unavailable' }, balance: null };
export class GcBalanceAwaitingSyncError extends Error {
  constructor() {
    super('GC balance is awaiting background sync');
    this.name = 'GcBalanceAwaitingSyncError';
  }
}
const fingerprint = (deployment: GcClaimDeployment) =>
  JSON.stringify({ ...deployment, claimScriptBytes: Array.from(deployment.claimScriptBytes) });
function amount(value: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18 || value < 0n)
    throw new Error('Invalid GC amount');
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

interface Inspection {
  context: GcClaimContext;
  deployment: GcClaimDeployment;
  entitlement: GcEntitlement;
  native: bigint;
  snapshot: WeeklyClaimSnapshot;
  row?: ITransaction;
  reconciliation?: GcClaimReconciliation;
  operations: { row: ITransaction; reconciliation: GcClaimReconciliation; terminal: boolean }[];
}
interface Quote {
  context: GcClaimContext;
  deployment: string;
  review: WeeklyClaimReview;
  prepared?: PreparedGcClaim;
  reclaim?: { row: ITransaction; requestBytes: Uint8Array; fee: bigint };
  receiptReserve?: bigint;
  receive?: { row: ITransaction; receiptId: string; requestBytes: Uint8Array; fee: bigint; nativeRefund: bigint };
  targetedRecovery?: boolean;
  result?: WeeklyClaimSnapshot;
  dispatched: boolean;
}

/** Backend-owned ephemeral approvals. Durable request uncertainty lives on ordinary wallet rows. */
export function createGcClaimBackendService(deps: GcClaimServiceDependencies): WeeklyClaimService {
  const quotes = new Map<string, Quote>();
  const history = new Map<string, { cursor: GcClaimHistoryCursor; blocked: boolean }>();
  async function contextFor(scope: ArcadeAccountScope) {
    const active = await deps.activeScope();
    if (active.networkId !== 'testnet' || scope.networkId !== active.networkId) throw new Error('GC network changed');
    const configured = await deps.deployment();
    if (!configured) throw new Error('GC deployment unavailable');
    const deployment = { ...configured, claimScriptBytes: new Uint8Array(configured.claimScriptBytes) };
    const context = await deps.normalizeContext({ ...deployment, accountId: active.accountId });
    const requested = await deps.normalizeContext({ ...deployment, accountId: scope.accountId });
    if (requested.accountId !== context.accountId) throw new Error('GC account changed');
    return { context, deployment };
  }
  function issuanceOf(result: { row: ITransaction; reconciliation: GcClaimReconciliation }) {
    return (
      result.reconciliation.evidence.find((item): item is GcClaimIssuanceEvidence => item.kind === 'issued') ??
      result.row.gcClaim?.issuance
    );
  }
  async function receivable(
    result: { row: ITransaction; reconciliation: GcClaimReconciliation },
    context: GcClaimContext
  ) {
    const issuance = issuanceOf(result);
    return (
      result.reconciliation.state === 'issued' &&
      result.reconciliation.receiptNoteBytes !== undefined &&
      issuance !== undefined &&
      !(await deps.receiptPending(context, issuance.receiptNoteId))
    );
  }
  async function inspect(scope: ArcadeAccountScope): Promise<Inspection> {
    const { context, deployment } = await contextFor(scope);
    const entitlement = await deps.entitlement(context);
    const snapshot: WeeklyClaimSnapshot = {
      allocationWeekStart: new Date((entitlement.approvedWeek * WEEK - MONDAY) * 1000).toISOString(),
      balance: null,
      status: { kind: 'checking' }
    };
    // Scan even when a local operation exists: another device may have funded a duplicate
    // request. Every authenticated history record is tracked independently before adjudication.
    const key = JSON.stringify([context, fingerprint(deployment)]);
    const previous = history.get(key);
    const page = await deps.history(context, deployment, previous?.cursor);
    await deps.restoreHistory(context, page);
    const blocked = previous?.blocked === true || page.unrecognizedRequestIds.length > 0;
    history.set(key, { cursor: page.cursor, blocked });
    const rows = (await deps.operations(context)).sort(
      (left, right) => (right.queuedSeq ?? right.initiatedAt) - (left.queuedSeq ?? left.initiatedAt)
    );
    const results: { row: ITransaction; reconciliation: GcClaimReconciliation; terminal: boolean }[] = [];
    for (const row of rows) {
      if (!row.gcClaim) throw new Error('GC operation unavailable');
      let reconciliation: GcClaimReconciliation;
      try {
        reconciliation = await deps.reconcile(context, row, deployment);
      } catch (error) {
        if (row.gcClaim.scope.approvedWeek === entitlement.approvedWeek) throw error;
        reconciliation = { state: 'pending', evidence: [] };
      }
      for (const evidence of reconciliation.evidence) await deps.recordEvidence(context, row.id, evidence);
      const terminal =
        reconciliation.state === 'reclaimed' ||
        (reconciliation.state === 'pending' &&
          reconciliation.requestNoteBytes === undefined &&
          deps.phase(row) === 'retryable');
      results.push({ row, reconciliation, terminal });
    }
    let minimumBalanceBlock = 0;
    for (const result of results) {
      minimumBalanceBlock = Math.max(
        minimumBalanceBlock,
        result.row.gcClaim?.delivery?.blockNumber ?? 0,
        result.row.gcClaim?.reclaim?.blockNumber ?? 0,
        ...result.reconciliation.evidence.map(item => item.blockNumber)
      );
    }
    const balances = await deps.balances(context, minimumBalanceBlock);
    snapshot.balance = amount(balances.gc, 6);
    const balanceIdentity = await contextFor(scope);
    if (
      JSON.stringify(balanceIdentity.context) !== JSON.stringify(context) ||
      fingerprint(balanceIdentity.deployment) !== fingerprint(deployment)
    )
      throw new Error('GC balance identity changed');
    // Recovery is an explicit, independently approved write even if another request delivered GC.
    snapshot.recoveries = results
      .filter(
        result =>
          result.row.gcClaim &&
          result.row.gcClaim.scope.approvedWeek < entitlement.approvedWeek &&
          result.reconciliation.state === 'reclaimable'
      )
      .sort((left, right) => left.row.gcClaim!.scope.approvedWeek - right.row.gcClaim!.scope.approvedWeek)
      .map(result => ({
        operationId: result.row.id,
        allocationWeekStart: new Date((result.row.gcClaim!.scope.approvedWeek * WEEK - MONDAY) * 1000).toISOString()
      }));
    const receipts: typeof results = [];
    for (const result of results) if (await receivable(result, context)) receipts.push(result);
    if (
      !page.complete ||
      results.some(
        result =>
          !result.terminal &&
          (result.reconciliation.state === 'pending' ||
            (result.reconciliation.state === 'issued' && !receipts.includes(result)))
      )
    )
      snapshot.pendingOperations = true;
    snapshot.receipts = receipts
      .filter(result => result.row.gcClaim!.scope.approvedWeek < entitlement.approvedWeek)
      .map(result => ({
        operationId: result.row.id,
        allocationWeekStart: new Date((result.row.gcClaim!.scope.approvedWeek * WEEK - MONDAY) * 1000).toISOString()
      }));
    const currentResults = results.filter(
      result => result.row.gcClaim?.scope.approvedWeek === entitlement.approvedWeek
    );
    const actionable = currentResults.find(result => result.reconciliation.state === 'reclaimable');
    const delivered = currentResults.find(result => result.reconciliation.state === 'delivered');
    const unresolved = currentResults.find(result => !result.terminal && result.reconciliation.state !== 'delivered');
    const receipt = receipts.find(result => result.row.gcClaim!.scope.approvedWeek === entitlement.approvedWeek);
    const selected = actionable ?? delivered ?? receipt ?? unresolved ?? currentResults[0];
    if (actionable?.row.gcClaim)
      snapshot.status = { kind: 'reclaimable', reclaimHeight: actionable.row.gcClaim.reclaimHeight };
    else if (delivered) snapshot.status = { kind: 'claimed', nextEligibleAt: entitlement.nextEligibleAt };
    else if (receipt) snapshot.status = { kind: 'receivable' };
    else if (unresolved || entitlement.claimed) snapshot.status = { kind: 'pending' };
    else if (blocked) snapshot.status = { kind: 'unavailable' };
    else if (page.complete && !blocked && !unresolved)
      snapshot.status =
        currentResults.length > 0
          ? { kind: 'failed' }
          : entitlement.claimed
            ? { kind: 'pending' }
            : { kind: 'eligible' };
    return {
      context,
      deployment,
      entitlement,
      native: balances.native,
      snapshot,
      operations: results,
      ...(selected ? { row: selected.row, reconciliation: selected.reconciliation } : {})
    };
  }

  return {
    async read(scope) {
      try {
        return (await inspect(scope)).snapshot;
      } catch (error) {
        if (error instanceof GcBalanceAwaitingSyncError) return { status: { kind: 'checking' }, balance: null };
        return unavailable;
      }
    },
    async prepare(scope, operationId) {
      const state = await inspect(scope);
      const { context, deployment, entitlement, snapshot } = state;
      const target = operationId
        ? state.operations.find(
            item =>
              item.row.id === operationId &&
              (item.reconciliation.state === 'reclaimable' || item.reconciliation.state === 'issued')
          )
        : undefined;
      if (operationId && !target) throw new Error('GC recovery operation unavailable');
      const recoveryRow = target?.row ?? state.row;
      const recoveryEvidence = target?.reconciliation ?? state.reconciliation;
      const receive = target ? await receivable(target, context) : snapshot.status.kind === 'receivable';
      const reclaim = target ? target.reconciliation.state === 'reclaimable' : snapshot.status.kind === 'reclaimable';
      if (target && !receive && !reclaim) throw new Error('GC receipt is already pending');
      const allocationWeek = reclaim || receive ? recoveryRow?.gcClaim?.scope.approvedWeek : entitlement.approvedWeek;
      if (allocationWeek === undefined) throw new Error('GC allocation unavailable');
      if (!reclaim && !receive && snapshot.status.kind !== 'eligible' && snapshot.status.kind !== 'failed')
        throw new Error('GC claim is pending or unavailable');
      const expires =
        reclaim || receive
          ? entitlement.referenceTimestamp + 300
          : Math.min(entitlement.referenceTimestamp + 300, (entitlement.approvedWeek + 1) * WEEK - MONDAY);
      if (expires <= deps.now()) throw new Error('GC approval week expired');
      const quote: Quote = {
        context,
        deployment: fingerprint(deployment),
        review: {
          quoteId: deps.quoteId(),
          mode: receive ? 'receive' : reclaim ? 'reclaim' : 'claim',
          allocationWeekStart: new Date((allocationWeek * WEEK - MONDAY) * 1000).toISOString(),
          expiresAt: new Date(expires * 1000).toISOString(),
          nativeSymbol: deployment.nativeSymbol,
          requestFee: '0',
          issuerBudget: '0',
          receiptFeeBudget: '0'
        },
        targetedRecovery: (reclaim || receive) && allocationWeek !== entitlement.approvedWeek,
        dispatched: false
      };
      if (receive) {
        const selected = target ?? state.operations.find(item => item.row.id === recoveryRow?.id);
        const issuance = selected && issuanceOf(selected);
        if (!selected || !issuance || !recoveryEvidence?.receiptNoteBytes) throw new Error('GC receipt unavailable');
        const result = await deps.prepareReceive(context, selected.row, issuance, recoveryEvidence.receiptNoteBytes);
        if (result.requestFee < 0n || state.native + issuance.nativeRefund < result.requestFee)
          throw new Error('Insufficient native fee funds');
        quote.receive = {
          row: selected.row,
          receiptId: issuance.receiptNoteId,
          requestBytes: new Uint8Array(result.requestBytes),
          fee: result.requestFee,
          nativeRefund: issuance.nativeRefund
        };
        quote.review.requestFee = amount(result.requestFee, deployment.nativeDecimals);
        quote.review.nativeRefund = amount(issuance.nativeRefund, deployment.nativeDecimals);
      } else if (reclaim) {
        if (!recoveryRow?.gcClaim || !recoveryEvidence?.requestNoteBytes)
          throw new Error('GC reclaim note unavailable');
        const result = await deps.prepareReclaim(context, deployment, recoveryRow, recoveryEvidence.requestNoteBytes);
        if (result.requestFee < 0n || state.native + recoveryRow.gcClaim.nativeBudget < result.requestFee)
          throw new Error('Insufficient native fee funds');
        quote.reclaim = { row: recoveryRow, requestBytes: new Uint8Array(result.requestBytes), fee: result.requestFee };
        quote.review.requestFee = amount(result.requestFee, deployment.nativeDecimals);
        quote.review.issuerBudget = amount(recoveryRow.gcClaim.nativeBudget, deployment.nativeDecimals);
      } else {
        const result = await deps.prepareClaim(context, deployment, entitlement);
        if (
          gcClaimBindingKey(result.prepared.scope) !== gcClaimBindingKey(context) ||
          result.prepared.scope.genesisCommitment !== context.genesisCommitment ||
          result.prepared.scope.accountId !== context.accountId ||
          result.prepared.scope.issuerId !== context.issuerId ||
          result.prepared.issuerCodeCommitment !== context.issuerCodeCommitment ||
          result.prepared.nativeAssetId !== context.nativeAssetId ||
          result.prepared.scope.approvedWeek !== entitlement.approvedWeek ||
          result.prepared.approvalExpiresAt > expires
        )
          throw new Error('GC preparation changed approved week or expiry');
        if (
          result.requestFee < 0n ||
          result.receiptFeeBudget < 0n ||
          state.native < result.prepared.outgoingNativeAmount + result.receiptFeeBudget
        )
          throw new Error('Insufficient native fee funds');
        quote.receiptReserve = result.receiptFeeBudget;
        quote.prepared = {
          ...result.prepared,
          scope: {
            ...result.prepared.scope,
            ...(result.prepared.scope.distribution === undefined
              ? {}
              : {
                  distribution: { ...result.prepared.scope.distribution }
                })
          },
          requestBytes: new Uint8Array(result.prepared.requestBytes)
        };
        quote.review.expiresAt = new Date(result.prepared.approvalExpiresAt * 1000).toISOString();
        quote.review.requestFee = amount(result.requestFee, deployment.nativeDecimals);
        quote.review.issuerBudget = amount(result.prepared.nativeBudget, deployment.nativeDecimals);
        quote.review.receiptFeeBudget = amount(result.receiptFeeBudget, deployment.nativeDecimals);
      }
      const preparedIdentity = await contextFor(scope);
      if (
        fingerprint(preparedIdentity.deployment) !== quote.deployment ||
        JSON.stringify(preparedIdentity.context) !== JSON.stringify(quote.context)
      )
        throw new Error('GC preparation identity changed');
      if (Date.parse(quote.review.expiresAt) <= deps.now() * 1000)
        throw new Error('GC approval expired during preparation');
      // Drop expired approvals, retaining only live quotes and their captured bytes.
      for (const [id, old] of quotes) if (Date.parse(old.review.expiresAt) <= deps.now() * 1000) quotes.delete(id);
      quotes.set(quote.review.quoteId, quote);
      return { ...quote.review };
    },
    async submit(scope, quoteId) {
      const quote = quotes.get(quoteId);
      if (!quote) throw new Error('GC approval is unavailable; review again');
      try {
        const current = await contextFor(scope);
        if (
          fingerprint(current.deployment) !== quote.deployment ||
          JSON.stringify(current.context) !== JSON.stringify(quote.context)
        )
          throw new Error('GC approval identity changed');
        if (quote.dispatched)
          return (
            quote.result ?? {
              status: { kind: 'pending' },
              balance: null,
              allocationWeekStart: quote.review.allocationWeekStart
            }
          );
        if (Date.parse(quote.review.expiresAt) <= deps.now() * 1000) throw new Error('GC approval expired');
        const state = await inspect(scope);
        if (Date.parse(quote.review.expiresAt) / 1000 <= state.entitlement.referenceTimestamp)
          throw new Error('GC approval expired by chain time');
        if (quote.prepared && entitlementWeek(quote.review) !== state.entitlement.approvedWeek)
          throw new Error('GC approval week changed');
        const finalIdentity = await contextFor(scope);
        if (
          fingerprint(finalIdentity.deployment) !== quote.deployment ||
          JSON.stringify(finalIdentity.context) !== JSON.stringify(quote.context)
        )
          throw new Error('GC approval identity changed');
        if (Date.parse(quote.review.expiresAt) <= deps.now() * 1000) throw new Error('GC approval expired');
        if (quote.dispatched) return quote.result ?? state.snapshot;
        const pendingResult: WeeklyClaimSnapshot = quote.targetedRecovery
          ? {
              ...state.snapshot,
              recoveries: state.snapshot.recoveries?.filter(item => item.operationId !== quote.reclaim?.row.id),
              receipts: state.snapshot.receipts?.filter(item => item.operationId !== quote.receive?.row.id)
            }
          : { ...state.snapshot, status: { kind: 'pending' } };
        quote.result = pendingResult;
        if (quote.prepared) {
          if (state.snapshot.status.kind !== 'eligible' && state.snapshot.status.kind !== 'failed')
            throw new Error('GC request already exists or is pending');
          if (state.native < quote.prepared.outgoingNativeAmount + (quote.receiptReserve ?? 0n))
            throw new Error('Insufficient native fee funds');
          quote.dispatched = true;
          await deps.queueClaim(quote.context, quote.prepared);
        } else if (quote.receive) {
          const receipt = quote.receive;
          const selected = state.operations.find(item => item.row.id === receipt.row.id);
          const issuance = selected && issuanceOf(selected);
          if (
            !selected ||
            !issuance ||
            issuance.receiptNoteId !== receipt.receiptId ||
            issuance.nativeRefund !== receipt.nativeRefund ||
            !(await receivable(selected, quote.context))
          )
            throw new Error('GC receipt state changed');
          if (state.native + issuance.nativeRefund < receipt.fee) throw new Error('Insufficient native fee funds');
          quote.dispatched = true;
          await deps.queueReceive(
            quote.context,
            receipt.receiptId,
            receipt.requestBytes,
            receipt.fee,
            Date.parse(quote.review.expiresAt) / 1000
          );
        } else if (quote.reclaim) {
          if (
            !state.operations.some(
              item =>
                item.row.id === quote.reclaim?.row.id &&
                item.reconciliation.state === 'reclaimable' &&
                item.row.gcClaim?.requestNoteId === quote.reclaim?.row.gcClaim?.requestNoteId
            )
          )
            throw new Error('GC reclaim state changed');
          quote.dispatched = true;
          await deps.queueReclaim(
            quote.context,
            quote.reclaim.row,
            quote.reclaim.requestBytes,
            quote.reclaim.fee,
            Date.parse(quote.review.expiresAt) / 1000
          );
        } else throw new Error('GC approval has no request');
        return pendingResult;
      } catch (error) {
        // Once admission was called its outcome may be ambiguous. Keep its captured operation
        // and pending result; no exception is permission to create another funded request.
        if (quote.dispatched)
          return (
            quote.result ?? {
              status: { kind: 'pending' },
              balance: null,
              allocationWeekStart: quote.review.allocationWeekStart
            }
          );
        let operations: ITransaction[];
        try {
          operations = await deps.operations(quote.context);
        } catch {
          throw error;
        }
        if (
          quote.prepared &&
          operations.some(
            row =>
              row.gcClaim?.scope.approvedWeek === quote.prepared?.scope.approvedWeek &&
              !['retryable', 'reclaimed', 'delivered'].includes(deps.phase(row))
          )
        )
          throw error;
        // This recognized approval never reached admission, and no durable uncertain sender
        // operation exists. Explicit non-submission may safely release the frontend's hold.
        quote.dispatched = true;
        quote.result = {
          status: { kind: 'failed' },
          balance: null,
          allocationWeekStart: quote.review.allocationWeekStart
        };
        return quote.result;
      }
    }
  };
}

function entitlementWeek(review: WeeklyClaimReview) {
  return Math.floor((Date.parse(review.allocationWeekStart) / 1000 + MONDAY) / WEEK);
}

// Production dependencies are loaded only after a configured request reaches the backend.
// Keeping the factory independent lets tests exercise the approval state machine without WASM or signing.
const production: GcClaimServiceDependencies = {
  async activeScope() {
    const [{ withUnlocked }, { getEffectiveNetworkName }] = await Promise.all([
      import('lib/miden/back/store'),
      import('lib/miden-chain/effective-endpoints')
    ]);
    return withUnlocked(async ({ vault }) => ({
      accountId: (await vault.getCurrentAccount()).publicKey,
      networkId: getEffectiveNetworkName()
    }));
  },
  deployment: async () => (await import('./gc-claim-deployment')).resolveGcClaimDeployment(),
  normalizeContext: async context => (await import('./gc-claim-operation')).normalizeGcClaimContext(context),
  entitlement: async context => (await import('./entitlement')).readGcEntitlement(context, context.accountId),
  balances: readVerifiedGcBalances,
  receiptPending: async (context, receiptId) =>
    (await import('./gc-claim-receive')).gcReceiptPending(context, receiptId),
  prepareReceive: async (context, _row, issuance, bytes) =>
    (await import('./gc-claim-receive')).prepareGcReceipt(context, issuance, bytes),
  queueReceive: async (context, receiptId, bytes, fee, expiresAt) => {
    await (await import('./gc-claim-receive')).queueGcReceipt(context, receiptId, bytes, fee, expiresAt);
    await wakeGcClaimProcessing();
  },
  async operations(context) {
    return (await (await import('./gc-claim-queue')).listGcClaimOperations(context)).map(item => item.transaction);
  },
  phase: row => {
    // This pure classifier trusts only the wallet's persisted node-verdict evidence.
    return classifyPhase(row);
  },
  restoreHistory: async (context, page) => (await import('./gc-claim-queue')).restoreGcClaimHistoryPage(context, page),
  history: async (context, deployment, cursor) =>
    (await import('./gc-claim-reconcile')).scanGcClaimHistoryPage(context, deployment, cursor),
  async reconcile(context, row, deployment) {
    if (!row.gcClaim) throw new Error('GC operation unavailable');
    return (await import('./gc-claim-reconcile')).reconcileGcClaim(context, row.gcClaim, deployment);
  },
  recordEvidence: async (context, id, evidence) =>
    (await import('./gc-claim-evidence')).recordGcClaimEvidence(context, id, evidence),
  async prepareClaim(context, deployment, entitlement) {
    const [{ buildFundedGcClaimRequest }, { ensureSdkWasmReady }, { NoteTag, AccountId }, { FEE_RESERVE_MULTIPLE }] =
      await Promise.all([
        import('./funded-claim-request'),
        import('lib/miden-chain/constants'),
        import('@miden-sdk/miden-sdk/lazy'),
        import('lib/miden/fees/spendable')
      ]);
    await ensureSdkWasmReady();
    const nativeBudget = BigInt(entitlement.verificationBaseFee) * BigInt(FEE_RESERVE_MULTIPLE);
    if (nativeBudget <= 0n) throw new Error('GC issuer fee budget unavailable');
    const approvalExpiresAt = Math.min(
      entitlement.referenceTimestamp + 300,
      (entitlement.approvedWeek + 1) * WEEK - MONDAY
    );
    const serial = Array.from(crypto.getRandomValues(new BigUint64Array(4)), value => value % 0xffffffff00000001n);
    const built = buildFundedGcClaimRequest({
      ...context,
      approvedWeek: entitlement.approvedWeek,
      approvalExpiresAt,
      reclaimHeight: entitlement.referenceBlock + deployment.reclaimDelayBlocks,
      receiptTag: NoteTag.withAccountTarget(AccountId.fromHex(context.accountId)).asU32(),
      nativeBudget,
      serial,
      claimScriptBytes: deployment.claimScriptBytes,
      claimScriptRoot: deployment.claimScriptRoot
    });
    const measured = await measureRequest(context, built.requestBytes, nativeBudget, false);
    return {
      prepared: {
        scope: gcClaimScope(context, entitlement.approvedWeek),
        issuerCodeCommitment: context.issuerCodeCommitment,
        nativeAssetId: context.nativeAssetId,
        requestNoteId: built.requestNoteId,
        receiptRecipientCommitment: built.receiptRecipientCommitment,
        nativeBudget,
        outgoingNativeAmount: nativeBudget + measured.fee,
        approvalExpiresAt,
        reclaimHeight: entitlement.referenceBlock + deployment.reclaimDelayBlocks,
        requestBytes: measured.bytes
      },
      requestFee: measured.fee,
      receiptFeeBudget: nativeBudget
    };
  },
  async prepareReclaim(context, _deployment, row, noteBytes) {
    const operation = row.gcClaim;
    if (!operation) throw new Error('GC reclaim operation unavailable');
    const [
      { NoteFile },
      { buildConsumeTransactionRequest, feeAwareRequestBuilder, randomFeeSalt },
      { ensureSdkWasmReady },
      { EXPIRATION_DELTA_BLOCKS },
      { withWasmClientLock, assertWasmHoldCurrent, getMidenClient }
    ] = await Promise.all([
      import('@miden-sdk/miden-sdk/lazy'),
      import('lib/miden/sdk/helpers'),
      import('lib/miden-chain/constants'),
      import('lib/miden/helpers'),
      import('lib/miden/sdk/miden-client')
    ]);
    await ensureSdkWasmReady();
    const requestBytes = await withWasmClientLock(
      async hold => {
        const note = NoteFile.deserialize(noteBytes).note();
        if (!note || note.id().toString() !== operation.requestNoteId) throw new Error('GC reclaim note changed');
        const { client } = await getMidenClient();
        assertWasmHoldCurrent(hold, 'GC reclaim after resolving client');
        const builder = await feeAwareRequestBuilder(client, context.accountId, randomFeeSalt());
        assertWasmHoldCurrent(hold, 'GC reclaim after resolving authentication');
        return buildConsumeTransactionRequest([note], EXPIRATION_DELTA_BLOCKS, builder).serialize();
      },
      { label: 'gc-reclaim-build' }
    );
    const measured = await measureRequest(
      context,
      requestBytes,
      operation.nativeBudget,
      true,
      noteBytes,
      operation.requestNoteId
    );
    return { requestBytes: measured.bytes, requestFee: measured.fee };
  },
  queueClaim: queueGcClaimRequest,
  queueReclaim: queueGcReclaim,
  now: () => Math.floor(Date.now() / 1000),
  quoteId: () => crypto.randomUUID()
};

/** A local private/public vault is readable only when its commitment still matches the pinned chain. */
export async function readVerifiedGcBalances(
  context: GcClaimContext,
  minimumBlock = 0
): Promise<{ gc: bigint; native: bigint }> {
  const [
    { midenClientProxy },
    { withWasmClientLock, assertWasmHoldCurrent },
    { RpcClient, AccountId },
    { ensureSdkWasmReady, getRpcEndpoint },
    { getEffectiveNetworkName, getEffectiveRpcUrl },
    { withRpcTimeout }
  ] = await Promise.all([
    import('lib/miden/back/miden-client-proxy'),
    import('lib/miden/sdk/miden-client'),
    import('@miden-sdk/miden-sdk/lazy'),
    import('lib/miden-chain/constants'),
    import('lib/miden-chain/effective-endpoints'),
    import('lib/miden-chain/rpc-timeout')
  ]);
  await ensureSdkWasmReady();
  const endpoint = getRpcEndpoint();
  const effectiveRpc = getEffectiveRpcUrl();
  if (getEffectiveNetworkName() !== context.network) throw new Error('GC balance network changed');
  const local = await withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(context.accountId);
      assertWasmHoldCurrent(hold, 'GC balances after account read');
      if (!account || account.id().toString() !== context.accountId) throw new Error('GC account balance unavailable');
      const commitment = account.to_commitment().toHex();
      const assets = account.vault().fungibleAssets();
      const balance = (faucet: string) =>
        assets.filter(asset => asset.faucetId().toString() === faucet).reduce((sum, asset) => sum + asset.amount(), 0n);
      return { commitment, gc: balance(gcClaimAssetId(context)), native: balance(context.nativeAssetId) };
    },
    { label: 'gc-claim-balance' }
  );
  await withRpcTimeout(
    async () => {
      const rpc = new RpcClient(endpoint);
      try {
        const genesis = await rpc.getBlockHeaderByNumber(0);
        if (genesis.commitment().toHex() !== context.genesisCommitment) throw new Error('GC balance genesis mismatch');
        const header = await rpc.getBlockHeaderByNumber();
        const height = header.blockNum();
        if (!Number.isSafeInteger(height) || height < minimumBlock || height < 0 || height > 0xffffffff)
          throw new Error('GC balance block unavailable');
        const proof = await rpc.getAccountProof(AccountId.fromHex(context.accountId), undefined, height);
        if (proof.blockNum() !== height || proof.accountId().toString() !== context.accountId)
          throw new Error('GC balance proof identity mismatch');
        if (proof.accountCommitment().toHex() !== local.commitment) throw new GcBalanceAwaitingSyncError();
      } finally {
        rpc.free();
      }
    },
    'GC balance proof',
    { retries: 0 }
  );
  if (getEffectiveNetworkName() !== context.network || getEffectiveRpcUrl() !== effectiveRpc)
    throw new Error('GC balance network changed');
  return { gc: local.gc, native: local.native };
}

/** Dispatch uses the wallet's existing processor and can only start after admission committed. */
export async function queueGcClaimRequest(context: GcClaimContext, prepared: PreparedGcClaim): Promise<void> {
  const { queuePreparedGcClaim, queueRenewedGcClaim, listGcClaimOperations } = await import('./gc-claim-queue');
  const prior = await listGcClaimOperations(context, prepared.scope.approvedWeek);
  const predecessor = [...prior].sort(
    (left, right) => (right.transaction.gcClaim?.attempt ?? -1) - (left.transaction.gcClaim?.attempt ?? -1)
  )[0]?.transaction.gcClaim;
  if (predecessor) await queueRenewedGcClaim(context, prepared, predecessor.requestNoteId);
  else await queuePreparedGcClaim(context, prepared);
  await wakeGcClaimProcessing();
}

async function wakeGcClaimProcessing(): Promise<void> {
  try {
    const { startTransactionProcessing } = await import('lib/miden/back/transaction-processor');
    startTransactionProcessing().catch(error => console.error('[GC] Background transaction processing failed', error));
  } catch (error) {
    console.error('[GC] Could not start background transaction processing', error);
  }
}

/** Ordinary execute rows hold the request note from their first insert; only reconciled dead attempts may renew. */
export async function queueGcReclaim(
  context: GcClaimContext,
  original: ITransaction,
  requestBytes: Uint8Array,
  fee: bigint,
  expiresAt: number
): Promise<void> {
  const approvedBytes = new Uint8Array(requestBytes);
  const [{ Transaction }, Repo, { queueOutgoingTransaction }, { releaseNoteIds }] = await Promise.all([
    import('lib/miden/db/types'),
    import('lib/miden/repo'),
    import('lib/miden/spending-limits/queue'),
    import('lib/miden/note-quarantine')
  ]);
  const operation = original.gcClaim;
  if (!operation) throw new Error('GC operation unavailable');
  const inventory = async () =>
    (await Repo.transactions.where('noteIds').equals(operation.requestNoteId).toArray()).filter(
      row => row.gcReclaimOf === original.id
    );
  const canRenew = (row: ITransaction) => classifyPhase({ ...row, gcClaim: operation }) === 'retryable';
  const prior = await inventory();
  if (prior.some(row => !canRenew(row))) {
    await wakeGcClaimProcessing();
    return;
  }
  const id = `gc-reclaim:${original.id}${prior.length ? `:attempt:${prior.length}` : ''}`;
  const spends = [{ faucetId: context.nativeAssetId, amount: fee }];
  const row = new Transaction(context.accountId, approvedBytes, [operation.requestNoteId], false, undefined, spends);
  row.id = id;
  const reclaimRow = {
    ...row,
    gcReclaimOf: original.id,
    heldNoteIds: [operation.requestNoteId],
    noteIds: [operation.requestNoteId]
  };
  try {
    await queueOutgoingTransaction(reclaimRow, spends, undefined, Math.floor(Date.now() / 1000), async () => {
      if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))
        throw new Error('GC recovery approval expired');
      const current = await inventory();
      if (current.length !== prior.length || current.some(item => !canRenew(item)))
        throw new Error('GC recovery queue changed');
    });
  } catch (error) {
    if (!(await Repo.transactions.get(id))) throw error;
  }
  await releaseNoteIds([operation.requestNoteId]);
  await wakeGcClaimProcessing();
}

async function measureRequest(
  context: GcClaimContext,
  requestBytes: Uint8Array,
  budget: bigint,
  reclaim: boolean,
  noteBytes?: Uint8Array,
  expectedInputId?: string
) {
  const [
    { midenClientProxy },
    { withWasmClientLock, assertWasmHoldCurrent },
    { simulatedBytesToView },
    { b64ToU8 },
    { accountRefToSdk }
  ] = await Promise.all([
    import('lib/miden/back/miden-client-proxy'),
    import('lib/miden/sdk/miden-client'),
    import('app/confirm/decode'),
    import('lib/shared/helpers'),
    import('lib/miden/sdk/helpers')
  ]);
  let simulated: Awaited<ReturnType<typeof midenClientProxy.dryRunTransaction>> | undefined;
  if (reclaim) {
    const [{ simulateCustomTransaction }, { u8ToB64 }, { runsWasmInThisRealm }] = await Promise.all([
      import('lib/miden/back/simulate-custom-tx'),
      import('lib/shared/helpers'),
      import('lib/miden/back/miden-client-proxy')
    ]);
    if (!runsWasmInThisRealm()) throw new Error('GC reclaim simulation is unavailable in this client realm');
    if (!noteBytes || !expectedInputId) throw new Error('GC authenticated reclaim input unavailable');
    const result = await simulateCustomTransaction({
      address: context.accountId,
      transactionRequest: u8ToB64(requestBytes),
      importNotes: [u8ToB64(noteBytes)],
      capturePreparedRequest: true
    });
    if (result.error) throw new Error('GC reclaim dry run unavailable');
    simulated = result;
  }
  return withWasmClientLock(
    async hold => {
      const result = simulated ?? (await midenClientProxy.dryRunTransaction(context.accountId, requestBytes, hold));
      assertWasmHoldCurrent(hold, 'GC request after dry run');
      if (!result.preparedRequestBytes) throw new Error('GC dry run has no captured request');
      if (expectedInputId) {
        const { TransactionSummary, TransactionResult } = await import('@miden-sdk/miden-sdk/lazy');
        assertWasmHoldCurrent(hold, 'GC reclaim before input verification');
        const inputs = result.summaryBytes
          ? TransactionSummary.deserialize(b64ToU8(result.summaryBytes)).inputNotes()
          : result.executedBytes
            ? TransactionResult.deserialize(b64ToU8(result.executedBytes)).executedTransaction().inputNotes()
            : undefined;
        if (!inputs || inputs.numNotes() !== 1 || inputs.getNote(0).id().toString() !== expectedInputId)
          throw new Error('GC reclaim consumed a different request');
      }
      const view = simulatedBytesToView(result);
      if (
        !view ||
        view.storageChanged ||
        (view.account && accountRefToSdk(view.account).toString() !== context.accountId)
      )
        throw new Error('GC dry run effects unavailable');
      const matching = (faucet: string) => accountRefToSdk(faucet).toString() === context.nativeAssetId;
      if (
        view.outgoing.some(asset => !matching(asset.faucetId)) ||
        view.incoming.some(asset => !matching(asset.faucetId)) ||
        (view.fee && !matching(view.fee.faucetId))
      )
        throw new Error('GC dry run moved another asset');
      const outgoing = view.outgoing.reduce((sum, asset) => sum + asset.amount, 0n);
      const incoming = view.incoming.reduce((sum, asset) => sum + asset.amount, 0n);
      if (
        (!reclaim && (outgoing !== budget || incoming !== 0n || view.inputNotesConsumed !== 0)) ||
        (reclaim && (incoming !== budget || outgoing !== 0n || view.inputNotesConsumed !== 1))
      )
        throw new Error('GC dry run effects differ from approval');
      return { bytes: b64ToU8(result.preparedRequestBytes), fee: view.fee?.amount ?? 0n };
    },
    { label: 'gc-claim-dry-run', watchdogMs: 30_000 }
  );
}

export const gcClaimBackendService = createGcClaimMigrationService(
  createGcClaimBackendService(production),
  createGcClaimBackendService({
    ...production,
    deployment: async () => (await import('./gc-claim-deployment')).resolveLegacyGcClaimDeployment()
  })
);
