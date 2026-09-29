import { GuardianHttpClient, GuardianHttpError, type HistoryPage } from '@openzeppelin/guardian-client';
import Dexie from 'dexie';

import { reportGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { MIDEN_GUARDIAN_ENDPOINTS } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { cacheScope } from 'lib/miden-chain/native-asset';
import type { WalletAccount } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import type { ITransaction } from '../db/types';
import { resolveGuardianEndpoint } from '../guardian/account';
import { withTimeout } from '../guardian/discover';
import {
  GUARDIAN_HISTORY_VERSION,
  GuardianHistoryCheckpoint,
  GuardianHistoryFailure,
  GuardianHistoryDataError,
  historyCheckpointId,
  normalizeHistoryOperators,
  recoveredHistoryRecord,
  reconcileRecoveredSwaps,
  sameNonemptyNotes
} from '../guardian/history';
import { GuardianHistoryFeeUnavailableError } from '../guardian/history-errors';
import {
  readGuardianHistoryGeneration,
  readGuardianHistoryState,
  saveGuardianHistoryCheckpoint
} from '../guardian/history-storage';
import { db, transactions } from '../repo';
import { canonicalWalletAccountId } from '../sdk/helpers';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

class HistoryInterrupted extends Error {}

type HistoryPageOutcome = { kind: 'page'; page: HistoryPage } | { kind: 'unsupported'; session: number };

/**
 * The interval on which the history phase re-writes its live progress record while it runs, from a timer in the realm
 * the pass runs in, so the record stays well inside GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS through every wait, those
 * with no deadline included: createClient's lock wait, and inline decode and commitment ops on mobile and desktop.
 * Each page also writes it at its start.
 */
export const GUARDIAN_HISTORY_PROGRESS_REFRESH_MS = 30_000;

export const MAX_HISTORY_ENTRIES_PER_SOURCE = 10_000;
export const MAX_HISTORY_CURSOR_LENGTH = 1024;
// The repeat check catches a loop of up to this many pages; termination rests on the entry cap and falling nonces.
export const MAX_HISTORY_SEEN_CURSORS = 64;

/**
 * Sessions a source can answer "no history" before it ends: empty for an operator the account may never have used,
 * and as a terminal failure for one it used. A source whose data fails a check in this many sessions is terminal too.
 */
export const MAX_UNSUPPORTED_HISTORY_PASSES = 3;

// Checkpoints answered unsupported since the backend started or the wallet last locked. A pass is counted once per
// session, so a deferral restart cannot spend the cap. An answer to an attempt issued before a lock is left out of it.
const unsupportedHistorySources = new Set<string>();
let unsupportedHistorySession = 0;

export function forgetUnsupportedHistorySources(): void {
  unsupportedHistorySession++;
  unsupportedHistorySources.clear();
}

export interface GuardianHistoryRecoveryContext {
  createClient: (
    account: WalletAccount,
    endpoint: string
  ) => Promise<{
    guardian: GuardianHttpClient;
    guardianAccountId: string;
  }>;
  shouldYield: () => Promise<string | null>;
  /** The history generation the detached run read when it started; every write of this pass is bound to it. */
  generation: string;
}

export function classifyHistoryFailure(error: Error): GuardianHistoryFailure {
  if (error instanceof GuardianHistoryDataError) return 'invalid-data';
  if (!(error instanceof GuardianHttpError)) return 'network';
  if (error.code === 'account_not_found') return 'account-not-found';
  switch (error.status) {
    case 401:
    case 403:
      return 'authentication';
    case 404:
    case 405:
    case 501:
      return 'unsupported';
    default:
      return 'network';
  }
}

async function historyRequest<T>(request: () => Promise<T>, check: () => Promise<void>): Promise<T> {
  await check();
  try {
    return await withTimeout(request(), 15_000, 'Guardian history request');
  } catch (error) {
    if (error instanceof GuardianHttpError && error.status < 500 && error.status !== 429) throw error;
    await check();
    return withTimeout(request(), 15_000, 'Guardian history request');
  }
}

export async function hasFailedGuardianHistory(account: WalletAccount): Promise<boolean> {
  const state = await readGuardianHistoryState();
  const accountId = canonicalWalletAccountId(account.publicKey);
  const network = getEffectiveNetworkName();
  const scope = cacheScope();
  // A node's "no fee" answer is terminal only for that node and this history version, so a Developer Settings
  // switch or a release that bumps the version lifts it at the next pass.
  return Object.values(state.checkpoints).some(
    checkpoint =>
      checkpoint.accountId === accountId &&
      checkpoint.network === network &&
      checkpoint.failure === 'fee-metadata' &&
      checkpoint.version === GUARDIAN_HISTORY_VERSION &&
      checkpoint.feeScope === scope
  );
}

export async function recoverGuardianHistory(account: WalletAccount, context: GuardianHistoryRecoveryContext) {
  if (await hasFailedGuardianHistory(account)) {
    return { deferred: false, sourceFailures: 1, restored: 0, failed: true, deferredSources: 0 };
  }
  const network = getEffectiveNetworkName();
  const canonicalAccountId = canonicalWalletAccountId(account.publicKey);
  const initialState = await readGuardianHistoryState();
  if (initialState.generation !== context.generation) {
    return { deferred: true, sourceFailures: 0, restored: 0, deferredSources: 0 };
  }
  const local = await transactions.where('accountId').equals(account.publicKey).toArray();
  const current = await resolveGuardianEndpoint(account);
  // Guardian history and backup files can name any host, so only rows this wallet made add operators.
  const previous: string[] = [];
  for (const row of local) {
    if (row.recovered || row.restoredFromBackup) continue;
    for (const value of [row.extraInputs?.previousGuardianEndpoint, row.extraInputs?.newGuardianEndpoint]) {
      if (typeof value === 'string') previous.push(value);
    }
  }
  const operators = normalizeHistoryOperators([current, ...(MIDEN_GUARDIAN_ENDPOINTS.get(network) ?? []), ...previous]);
  const ownOperators = normalizeHistoryOperators([current, ...previous]);
  // Every write of this pass relies on this: reportHistory carries no guard of its own.
  const interrupted = async () => {
    if (await context.shouldYield()) return true;
    if (network !== getEffectiveNetworkName()) return true;
    return (await readGuardianHistoryGeneration()) !== context.generation;
  };
  const check = async () => {
    if (await interrupted()) throw new HistoryInterrupted();
  };
  let sourceFailures = 0;
  let deferredSources = 0;
  let restored = local.filter(row => row.recovered && row.recovery?.network === network).length;
  const commitments = new Map<string, string>();
  const reportHistory = async (operator: string) => {
    await reportGuardianNoteRecoveryProgress({
      accountId: account.publicKey,
      step: 'history',
      operator,
      restored,
      sourcesClean: true,
      historyGeneration: context.generation
    });
  };
  // Ticks run one at a time on one chain, and the phase awaits it before returning, so no tick lands after the
  // terminal record. A progress write never fails the recovery it narrates, so a tick never rejects.
  let currentOperator: string | undefined;
  let stopped = false;
  let ticks = Promise.resolve();
  const tick = async () => {
    try {
      if (stopped || (await interrupted())) return;
      const operator = currentOperator;
      if (stopped || operator === undefined) return;
      await reportHistory(operator);
    } catch (error) {
      console.warn('[GuardianHistory] Could not refresh the live progress record:', error);
    }
  };
  // Only a clean notes pass reaches this phase, so a retry may resume here.
  if (operators[0] !== undefined) await reportHistory(operators[0]);
  const refresh = setInterval(() => {
    ticks = ticks.then(tick);
  }, GUARDIAN_HISTORY_PROGRESS_REFRESH_MS);
  try {
    for (const operator of operators) {
      const id = historyCheckpointId(network, canonicalAccountId, operator);
      const stored = initialState.checkpoints[id];
      // Only a current-version checkpoint resumes, so every save carries the version the fee stop matches.
      let checkpoint: GuardianHistoryCheckpoint =
        stored?.version === GUARDIAN_HISTORY_VERSION
          ? stored
          : {
              id,
              network,
              accountId: canonicalAccountId,
              operator,
              version: GUARDIAN_HISTORY_VERSION,
              seenCursors: [],
              completed: false,
              restored: 0
            };
      if (checkpoint.completed) continue;
      if (unsupportedHistorySources.has(id) && checkpoint.failure === 'unsupported') {
        if (ownOperators.includes(operator)) sourceFailures++;
        else deferredSources++;
        continue;
      }
      currentOperator = operator;
      try {
        if (checkpoint.cursor && checkpoint.cursor.length > MAX_HISTORY_CURSOR_LENGTH)
          throw new GuardianHistoryDataError('Saved Guardian history cursor exceeds the length limit');
        await check();
        const { guardian, guardianAccountId } = await context.createClient(account, operator);
        while (!checkpoint.completed) {
          await reportHistory(operator);
          const pageCheckpoint = checkpoint;
          // A timed-out attempt can settle after its retry starts, so each reports only through its own value.
          // eslint-disable-next-line no-loop-func -- each attempt reads the session current when it is issued
          const outcome = await historyRequest(() => {
            const session = unsupportedHistorySession;
            return guardian.getDeltaHistory(guardianAccountId, { limit: 50, cursor: pageCheckpoint.cursor }).then(
              (page): HistoryPageOutcome => ({ kind: 'page', page }),
              (error): HistoryPageOutcome => {
                if (error instanceof GuardianHttpError && !pageCheckpoint.cursor && pageCheckpoint.restored === 0) {
                  if (error.code === 'account_not_found')
                    return { kind: 'page', page: { entries: [], nextCursor: undefined } };
                  if (classifyHistoryFailure(error) === 'unsupported') return { kind: 'unsupported', session };
                }
                throw error;
              }
            );
          }, check);
          if (outcome.kind === 'unsupported') {
            // Asked once per session up to MAX_UNSUPPORTED_HISTORY_PASSES: an operator the account may never have
            // used is a deferred source and then completes empty, while one it used is a failed source and then
            // stops recovery as the fee stop does.
            const own = ownOperators.includes(operator);
            const unsupportedPasses = (checkpoint.unsupportedPasses ?? 0) + 1;
            const exhausted = unsupportedPasses >= MAX_UNSUPPORTED_HISTORY_PASSES;
            checkpoint = { ...checkpoint, failure: 'unsupported', unsupportedPasses, completed: exhausted && !own };
            if (!(await saveGuardianHistoryCheckpoint(context.generation, checkpoint))) throw new HistoryInterrupted();
            if (exhausted && own) {
              return { deferred: false, sourceFailures: sourceFailures + 1, restored, failed: true, deferredSources };
            }
            if (!exhausted) {
              if (outcome.session === unsupportedHistorySession) unsupportedHistorySources.add(id);
              if (own) sourceFailures++;
              else deferredSources++;
            }
            break;
          }
          const { page } = outcome;
          if (page.entries.length > 50)
            throw new GuardianHistoryDataError('Guardian history page exceeds the requested limit');
          if (page.nextCursor && page.nextCursor.length > MAX_HISTORY_CURSOR_LENGTH)
            throw new GuardianHistoryDataError('Guardian history cursor exceeds the length limit');
          if (
            page.nextCursor &&
            (page.nextCursor === checkpoint.cursor || checkpoint.seenCursors.includes(page.nextCursor))
          ) {
            throw new GuardianHistoryDataError('Guardian history cursor repeats');
          }
          if (page.entries.length === 0 && page.nextCursor)
            throw new GuardianHistoryDataError('Guardian history page is empty but not the last');
          // Operators list history newest-first by nonce, so each page must fall below every earlier one.
          const { lowestNonce } = checkpoint;
          if (lowestNonce !== undefined && page.entries.some(entry => !(entry.nonce < lowestNonce)))
            throw new GuardianHistoryDataError('Guardian history nonces do not fall across pages');
          const entryCount = (checkpoint.entryCount ?? 0) + page.entries.length;
          if (entryCount > MAX_HISTORY_ENTRIES_PER_SOURCE)
            throw new GuardianHistoryDataError('Guardian history exceeds the entry limit');
          const records: ITransaction[] = [];
          for (const entry of page.entries) {
            const delta = await historyRequest(() => guardian.getDelta(guardianAccountId, entry.nonce), check);
            await check();
            const summary = await midenClientProxy.decodeGuardianHistory(delta.deltaPayload.txSummary.data);
            const record = recoveredHistoryRecord(
              account.publicKey,
              canonicalAccountId,
              network,
              operator,
              entry,
              delta,
              summary
            );
            records.push(record);
          }
          // Decode local results outside the database transaction and between yield checks.
          for (const row of local) {
            if (!row.resultBytes || commitments.has(row.id) || row.recovery) continue;
            await check();
            try {
              commitments.set(row.id, await midenClientProxy.getGuardianResultCommitment(row.resultBytes));
            } catch (error) {
              if (error instanceof OperationAbortedError || error instanceof WasmClientPoisonedError) throw error;
              commitments.set(row.id, '');
            }
          }
          await check();
          let added = 0;
          await db.transaction('rw', transactions, async () => {
            await Dexie.waitFor(check());
            const existing = await transactions.where('accountId').equals(account.publicKey).toArray();
            for (const record of records) {
              const finalCommitment = record.recovery?.finalCommitment;
              const match = existing.find(row => {
                if (row.recovery && row.recovery.network !== network) return false;
                if (row.id === record.id) return true;
                const localCommitment = row.recovery?.finalCommitment ?? commitments.get(row.id);
                if (finalCommitment && localCommitment) return finalCommitment === localCommitment;
                const inputMatches = sameNonemptyNotes(row.inputNoteIds, record.inputNoteIds);
                const outputMatches = sameNonemptyNotes(row.outputNoteIds, record.outputNoteIds);
                if (row.inputNoteIds?.length && record.inputNoteIds?.length && !inputMatches) return false;
                if (row.outputNoteIds?.length && record.outputNoteIds?.length && !outputMatches) return false;
                return (
                  inputMatches ||
                  outputMatches ||
                  (row.type === 'consume' &&
                    record.type === 'consume' &&
                    sameNonemptyNotes(row.noteIds, record.noteIds))
                );
              });
              if (match) {
                if (match.recovered) {
                  if (match.recovery) {
                    const operators = normalizeHistoryOperators([...match.recovery.operators, operator]);
                    const recovery = { ...match.recovery, operators };
                    if (
                      record.recovery?.completeness === 'decoded' &&
                      (match.recovery.completeness === 'partial' || match.recovery.version < GUARDIAN_HISTORY_VERSION)
                    ) {
                      const upgraded = { ...record, id: match.id, recovery: { ...record.recovery, operators } };
                      await transactions.put(upgraded);
                      Object.assign(match, upgraded);
                    } else {
                      await transactions.update(match.id, { recovery });
                      match.recovery = recovery;
                    }
                  }
                } else if (
                  match.type === 'consume' &&
                  record.type === 'consume' &&
                  record.recovery?.completeness === 'decoded'
                ) {
                  // A local row keeps its own receipt fields and gains only the retained note links.
                  const recovery = {
                    ...record.recovery,
                    operators: normalizeHistoryOperators([
                      ...(match.recovery?.operators ?? []),
                      ...record.recovery.operators
                    ])
                  };
                  match.recovery = recovery;
                  await transactions.update(match.id, { recovery });
                }
                continue;
              }
              await transactions.put(record);
              existing.push(record);
              added++;
            }
            for (const row of reconcileRecoveredSwaps(existing)) await transactions.put(row);
          });
          restored += added;
          checkpoint = {
            ...checkpoint,
            cursor: page.nextCursor,
            seenCursors: [...checkpoint.seenCursors, ...(checkpoint.cursor ? [checkpoint.cursor] : [])].slice(
              -MAX_HISTORY_SEEN_CURSORS
            ),
            completed: !page.nextCursor,
            restored: checkpoint.restored + added,
            lowestNonce: page.entries.reduce<number | undefined>(
              (lowest, entry) => (lowest === undefined ? entry.nonce : Math.min(lowest, entry.nonce)),
              lowestNonce
            ),
            entryCount,
            failure: undefined,
            feeScope: undefined
          };
          if (!(await saveGuardianHistoryCheckpoint(context.generation, checkpoint))) throw new HistoryInterrupted();
        }
      } catch (error) {
        if (
          error instanceof HistoryInterrupted ||
          error instanceof OperationAbortedError ||
          error instanceof WasmClientPoisonedError
        )
          throw error;
        if (error instanceof GuardianHistoryFeeUnavailableError) {
          await saveGuardianHistoryCheckpoint(context.generation, {
            ...checkpoint,
            failure: 'fee-metadata',
            feeScope: cacheScope()
          });
          return { deferred: false, sourceFailures: sourceFailures + 1, restored, failed: true, deferredSources };
        }
        sourceFailures++;
        const failure = error instanceof Error ? classifyHistoryFailure(error) : 'invalid-data';
        // Data that fails a check fails the same way on every retry, so it is terminal once it repeats up to the
        // cap. A failed source is offered again only after the next lock, so each run here is a new session.
        const invalidDataPasses = failure === 'invalid-data' ? (checkpoint.invalidDataPasses ?? 0) + 1 : undefined;
        await saveGuardianHistoryCheckpoint(context.generation, {
          ...checkpoint,
          failure,
          invalidDataPasses: invalidDataPasses ?? checkpoint.invalidDataPasses
        });
        console.warn(`[GuardianHistory] Source failed (${failure}): ${operator}`, error);
        if (invalidDataPasses !== undefined && invalidDataPasses >= MAX_UNSUPPORTED_HISTORY_PASSES) {
          return { deferred: false, sourceFailures, restored, failed: true, deferredSources };
        }
      }
    }
  } catch (error) {
    if (
      error instanceof HistoryInterrupted ||
      error instanceof OperationAbortedError ||
      error instanceof WasmClientPoisonedError
    ) {
      return { deferred: true, sourceFailures, restored, deferredSources };
    }
    throw error;
  } finally {
    clearInterval(refresh);
    stopped = true;
    await ticks;
  }
  return { deferred: false, sourceFailures, restored, deferredSources };
}
