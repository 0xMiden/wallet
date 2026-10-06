import { GuardianHttpClient, GuardianHttpError, type HistoryPage } from '@openzeppelin/guardian-client';
import Dexie from 'dexie';

import { reportGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { MIDEN_GUARDIAN_ENDPOINTS } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { cacheScope } from 'lib/miden-chain/native-asset';
import type { WalletAccount } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import { type ITransaction, ITransactionStatus } from '../db/types';
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
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

class HistoryInterrupted extends Error {}

// An eviction or an offscreen abort of a summary or local result-commitment decode the pass was not interrupted for.
// It says the decode did not finish, not that the bytes failed a check, so the source is filed 'network' and never
// spends the invalid-data cap.
class HistoryDecodeAborted extends Error {
  constructor(
    readonly session: number,
    cause: Error
  ) {
    super('Guardian history decode was aborted', { cause });
  }
}

// A failure of one request attempt, carrying the session that attempt was issued in.
class HistoryRequestFailed extends Error {
  constructor(
    readonly session: number,
    cause: unknown
  ) {
    super('Guardian history request failed', { cause });
  }
}

type HistoryPageOutcome =
  | { kind: 'page'; page: HistoryPage; session: number }
  | { kind: 'unsupported'; session: number };

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
 * and as a terminal failure for one it used. A source whose data fails a check in this many sessions is terminal too,
 * and an operator the account may never have used whose request cannot be answered in this many sessions (its
 * deferredFailurePasses) completes empty, as one whose decode does not finish in MAX_ABORTED_DECODE_PASSES sessions
 * does. Each count is spent at most once per session, and a terminal source ends recovery once the pass has read the
 * other operators. A failure that no request or decode carries (a fee lookup that fails with an error, a client that
 * cannot be built, a local write) spends no count and has no cap: it is the wallet's own and meets every operator.
 */
export const MAX_UNSUPPORTED_HISTORY_PASSES = 3;

/**
 * Sessions in which a summary or local result-commitment decode for an operator the account may never have used can
 * fail to finish (its abortedDecodePasses) before the operator completes empty. The decode did not finish when its
 * wait for the WASM lock, a fee lookup inside it or its walk ran past the offscreen deadline, or an eviction took it;
 * a trap on the operator's bytes is invalid data instead. An abort in every session is a decode this device cannot
 * finish in time, while the higher cap lets a transient stall behind the post-unlock sync pass. An abort is charged
 * only in the session it began in.
 */
export const MAX_ABORTED_DECODE_PASSES = 2 * MAX_UNSUPPORTED_HISTORY_PASSES;

function atHistoryCap(checkpoint: GuardianHistoryCheckpoint): boolean {
  if (checkpoint.failure === 'unsupported')
    return !checkpoint.completed && (checkpoint.unsupportedPasses ?? 0) >= MAX_UNSUPPORTED_HISTORY_PASSES;
  return checkpoint.failure === 'invalid-data' && (checkpoint.invalidDataPasses ?? 0) >= MAX_UNSUPPORTED_HISTORY_PASSES;
}

// Checkpoints answered unsupported, whose data failed a check, whose summary or commitment decode was aborted, or whose
// operator the account may never have used was deferred because a request could not be answered (deferredFailurePasses)
// or a decode was aborted (abortedDecodePasses), since the backend started or the wallet last locked. Each is recorded
// once per session, so a deferral restart cannot spend a cap or decode again. An answer to an attempt or a decode
// begun before a lock is left out of the session the lock started.
const unsupportedHistorySources = new Set<string>();
const invalidDataHistorySources = new Set<string>();
const abortedDecodeHistorySources = new Set<string>();
const deferredFailureHistorySources = new Set<string>();
let unsupportedHistorySession = 0;

export function forgetUnsupportedHistorySources(): void {
  unsupportedHistorySession++;
  unsupportedHistorySources.clear();
  invalidDataHistorySources.clear();
  abortedDecodeHistorySources.clear();
  deferredFailureHistorySources.clear();
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

// Each attempt reads the session once, as it is issued, and hands it to the request and to its failure alike.
async function historyRequest<T>(request: (session: number) => Promise<T>, check: () => Promise<void>): Promise<T> {
  const attempt = async () => {
    const session = unsupportedHistorySession;
    try {
      return await withTimeout(request(session), 15_000, 'Guardian history request');
    } catch (error) {
      throw new HistoryRequestFailed(session, error);
    }
  };
  await check();
  try {
    return await attempt();
  } catch (error) {
    const cause = error instanceof HistoryRequestFailed ? error.cause : error;
    if (cause instanceof GuardianHttpError && cause.status < 500 && cause.status !== 429) throw error;
    await check();
    return attempt();
  }
}

/**
 * The history generation in which this account has a terminal history checkpoint on the effective network, of this
 * history version, or null when it has none: a node's "no fee" answer (`fee-metadata`) from the node recovery now
 * reads, or a source a pass marked `terminal` (an own operator's unsupported answer or a source's invalid data at
 * MAX_UNSUPPORTED_HISTORY_PASSES). A Developer Settings node switch lifts only the fee stop, while a release that
 * bumps the version lifts every kind. A checkpoint at a cap without the marker is left out: the pass that capped it
 * deferred or met another source's failure, so a later pass reads the other operators before it ends recovery.
 * The state is read once, so the generation returned is the one whose checkpoints were judged.
 */
export async function terminalGuardianHistoryGeneration(account: WalletAccount): Promise<string | null> {
  const state = await readGuardianHistoryState();
  const accountId = canonicalWalletAccountId(account.publicKey);
  const network = getEffectiveNetworkName();
  const scope = cacheScope();
  const terminal = Object.values(state.checkpoints).some(
    checkpoint =>
      checkpoint.accountId === accountId &&
      checkpoint.network === network &&
      checkpoint.version === GUARDIAN_HISTORY_VERSION &&
      ((checkpoint.failure === 'fee-metadata' && checkpoint.feeScope === scope) || checkpoint.terminal === true)
  );
  return terminal ? state.generation : null;
}

/** Whether {@link terminalGuardianHistoryGeneration} finds a terminal history checkpoint for this account. */
export async function hasFailedGuardianHistory(account: WalletAccount): Promise<boolean> {
  return (await terminalGuardianHistoryGeneration(account)) !== null;
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
  const current = resolveGuardianEndpoint(account);
  // Guardian history and backup files can name any host, so only rows this wallet made add operators.
  const previous: string[] = [];
  for (const row of local) {
    if (row.recovered || row.restoredFromBackup) continue;
    // A switch's origin is always the wallet's own endpoint; its target only once the switch completed.
    const target = row.status === ITransactionStatus.Completed ? row.extraInputs?.newGuardianEndpoint : undefined;
    for (const value of [row.extraInputs?.previousGuardianEndpoint, target]) {
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
  // Sources this pass found at a cap. They end recovery only if every other source completes in the same pass.
  const terminal: GuardianHistoryCheckpoint[] = [];
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
      if (atHistoryCap(checkpoint)) {
        sourceFailures++;
        terminal.push(checkpoint);
        continue;
      }
      if (unsupportedHistorySources.has(id) && checkpoint.failure === 'unsupported') {
        if (ownOperators.includes(operator)) sourceFailures++;
        else deferredSources++;
        continue;
      }
      if (invalidDataHistorySources.has(id) && checkpoint.failure === 'invalid-data') {
        sourceFailures++;
        continue;
      }
      if (abortedDecodeHistorySources.has(id) && checkpoint.failure === 'network') {
        sourceFailures++;
        continue;
      }
      if (
        deferredFailureHistorySources.has(id) &&
        checkpoint.failure !== undefined &&
        !ownOperators.includes(operator)
      ) {
        deferredSources++;
        continue;
      }
      currentOperator = operator;
      // A data failure belongs to the session of the request that returned the data: the page's for the page
      // checks, the entry's getDelta for that entry.
      let dataSession = unsupportedHistorySession;
      // The node a fee-unavailable answer came from: read before the decode that answered.
      let decodeScope: string | undefined;
      try {
        if (checkpoint.cursor && checkpoint.cursor.length > MAX_HISTORY_CURSOR_LENGTH)
          throw new GuardianHistoryDataError('Saved Guardian history cursor exceeds the length limit');
        await check();
        const { guardian, guardianAccountId } = await context.createClient(account, operator);
        while (!checkpoint.completed) {
          await reportHistory(operator);
          const pageCheckpoint = checkpoint;
          // A timed-out attempt can settle after its retry starts, so each reports only through its own value.
          const outcome = await historyRequest(
            session =>
              guardian.getDeltaHistory(guardianAccountId, { limit: 50, cursor: pageCheckpoint.cursor }).then(
                (page): HistoryPageOutcome => ({ kind: 'page', page, session }),
                (error): HistoryPageOutcome => {
                  if (error instanceof GuardianHttpError && !pageCheckpoint.cursor && pageCheckpoint.restored === 0) {
                    if (error.code === 'account_not_found')
                      return { kind: 'page', page: { entries: [], nextCursor: undefined }, session };
                    if (classifyHistoryFailure(error) === 'unsupported') return { kind: 'unsupported', session };
                  }
                  throw error;
                }
              ),
            check
          );
          dataSession = outcome.session;
          if (outcome.kind === 'unsupported') {
            // Asked once per session up to MAX_UNSUPPORTED_HISTORY_PASSES: an operator the account may never have
            // used is a deferred source and then completes empty, while one it used is a failed source and then a
            // terminal one, which ends recovery once the pass has read the other operators.
            const own = ownOperators.includes(operator);
            const unsupportedPasses = (checkpoint.unsupportedPasses ?? 0) + 1;
            const exhausted = unsupportedPasses >= MAX_UNSUPPORTED_HISTORY_PASSES;
            checkpoint = { ...checkpoint, failure: 'unsupported', unsupportedPasses, completed: exhausted && !own };
            if (!(await saveGuardianHistoryCheckpoint(context.generation, checkpoint))) throw new HistoryInterrupted();
            if (exhausted && own) {
              sourceFailures++;
              terminal.push(checkpoint);
            } else if (!exhausted) {
              if (outcome.session === unsupportedHistorySession) unsupportedHistorySources.add(id);
              if (own) sourceFailures++;
              else deferredSources++;
            }
            break;
          }
          const { page } = outcome;
          if (page.entries.length > 50)
            throw new GuardianHistoryDataError('Guardian history page exceeds the requested limit');
          // The checkpoint schema keeps only string cursors, so any other one would drop every saved checkpoint.
          if (
            page.nextCursor !== undefined &&
            (typeof page.nextCursor !== 'string' || page.nextCursor.length > MAX_HISTORY_CURSOR_LENGTH)
          )
            throw new GuardianHistoryDataError('Guardian history cursor exceeds the length limit');
          if (
            page.nextCursor &&
            (page.nextCursor === checkpoint.cursor || checkpoint.seenCursors.includes(page.nextCursor))
          ) {
            throw new GuardianHistoryDataError('Guardian history cursor repeats');
          }
          if (page.entries.length === 0 && page.nextCursor)
            throw new GuardianHistoryDataError('Guardian history page is empty but not the last');
          // An entry without a safe integer nonce would reach getDelta, which cannot request it or sends a fraction.
          if (page.entries.some(entry => !Number.isSafeInteger(entry.nonce)))
            throw new GuardianHistoryDataError('Guardian history entry is not canonical');
          // Operators list history newest-first by nonce, so each page must fall below every earlier one.
          const { lowestNonce } = checkpoint;
          if (lowestNonce !== undefined && page.entries.some(entry => !(entry.nonce < lowestNonce)))
            throw new GuardianHistoryDataError('Guardian history nonces do not fall across pages');
          const entryCount = (checkpoint.entryCount ?? 0) + page.entries.length;
          if (entryCount > MAX_HISTORY_ENTRIES_PER_SOURCE)
            throw new GuardianHistoryDataError('Guardian history exceeds the entry limit');
          const records: ITransaction[] = [];
          for (const entry of page.entries) {
            const answer = await historyRequest(
              session => guardian.getDelta(guardianAccountId, entry.nonce).then(delta => ({ delta, session })),
              check
            );
            dataSession = answer.session;
            // The delta already parsed and mapped inside getDelta, so a summary missing from it is the operator's data.
            const encoded = answer.delta.deltaPayload?.txSummary?.data;
            if (typeof encoded !== 'string' || encoded.length === 0)
              throw new GuardianHistoryDataError('Guardian history delta carries no summary');
            await check();
            const decodeSession = unsupportedHistorySession;
            decodeScope = cacheScope();
            const summary = await midenClientProxy.decodeGuardianHistory(encoded).catch(async (error: unknown) => {
              if (!(isWasmClientPoisonedError(error) || error instanceof OperationAbortedError)) throw error;
              if (await interrupted()) throw error;
              throw new HistoryDecodeAborted(decodeSession, error);
            });
            const record = recoveredHistoryRecord(
              account.publicKey,
              canonicalAccountId,
              network,
              operator,
              entry,
              answer.delta,
              summary
            );
            records.push(record);
          }
          // Decode local results outside the database transaction and between yield checks, only for a page that has
          // records to match: a page without any would be charged for an abort it has no use for.
          for (const row of records.length > 0 ? local : []) {
            if (!row.resultBytes || commitments.has(row.id) || row.recovery) continue;
            await check();
            const commitmentSession = unsupportedHistorySession;
            try {
              commitments.set(row.id, await midenClientProxy.getGuardianResultCommitment(row.resultBytes));
            } catch (error) {
              if (error instanceof OperationAbortedError || isWasmClientPoisonedError(error)) {
                if (await interrupted()) throw error;
                throw new HistoryDecodeAborted(commitmentSession, error);
              }
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
            feeScope: undefined,
            deferredFailurePasses: undefined,
            abortedDecodePasses: undefined
          };
          if (!(await saveGuardianHistoryCheckpoint(context.generation, checkpoint))) throw new HistoryInterrupted();
        }
      } catch (thrown) {
        const error = thrown instanceof HistoryRequestFailed ? thrown.cause : thrown;
        if (
          error instanceof HistoryInterrupted ||
          error instanceof OperationAbortedError ||
          isWasmClientPoisonedError(error)
        )
          throw error;
        if (error instanceof GuardianHistoryFeeUnavailableError) {
          if (await interrupted()) throw new HistoryInterrupted();
          const stopped = await saveGuardianHistoryCheckpoint(context.generation, {
            ...checkpoint,
            failure: 'fee-metadata',
            feeScope: decodeScope ?? cacheScope()
          });
          if (!stopped) throw new HistoryInterrupted();
          return { deferred: false, sourceFailures: sourceFailures + 1, restored, failed: true, deferredSources };
        }
        const failure = error instanceof Error ? classifyHistoryFailure(error) : 'invalid-data';
        if (failure !== 'invalid-data' && !ownOperators.includes(operator)) {
          // Each class spends only its own count, once: a failed request its deferredFailurePasses, in the session its
          // attempt was issued in, and an aborted decode its abortedDecodePasses, only if it began in this session. A
          // failure neither carries, such as a failed fee lookup on the wallet's own node, defers the source uncounted.
          const session =
            thrown instanceof HistoryRequestFailed || thrown instanceof HistoryDecodeAborted
              ? thrown.session
              : undefined;
          const deferredFailurePasses =
            thrown instanceof HistoryRequestFailed
              ? (checkpoint.deferredFailurePasses ?? 0) + 1
              : checkpoint.deferredFailurePasses;
          const abortedDecodePasses =
            thrown instanceof HistoryDecodeAborted && thrown.session === unsupportedHistorySession
              ? (checkpoint.abortedDecodePasses ?? 0) + 1
              : checkpoint.abortedDecodePasses;
          const completed =
            (deferredFailurePasses ?? 0) >= MAX_UNSUPPORTED_HISTORY_PASSES ||
            (abortedDecodePasses ?? 0) >= MAX_ABORTED_DECODE_PASSES;
          const deferred = { ...checkpoint, failure, deferredFailurePasses, abortedDecodePasses, completed };
          if (!(await saveGuardianHistoryCheckpoint(context.generation, deferred))) throw new HistoryInterrupted();
          if (!completed) {
            deferredSources++;
            if (session === unsupportedHistorySession) deferredFailureHistorySources.add(id);
          }
          console.warn(`[GuardianHistory] Source deferred (${failure}): ${operator}`, error);
          continue;
        }
        sourceFailures++;
        // Data that fails a check fails the same way on every retry, so it is terminal once it repeats up to the
        // cap. The count is spent at most once per session, so a deferral restart does not ask the source again.
        const invalidDataPasses = failure === 'invalid-data' ? (checkpoint.invalidDataPasses ?? 0) + 1 : undefined;
        const saved = { ...checkpoint, failure, invalidDataPasses: invalidDataPasses ?? checkpoint.invalidDataPasses };
        if (!(await saveGuardianHistoryCheckpoint(context.generation, saved))) throw new HistoryInterrupted();
        if (failure === 'invalid-data' && dataSession === unsupportedHistorySession) invalidDataHistorySources.add(id);
        if (error instanceof HistoryDecodeAborted && error.session === unsupportedHistorySession)
          abortedDecodeHistorySources.add(id);
        console.warn(`[GuardianHistory] Source failed (${failure}): ${operator}`, error);
        if (invalidDataPasses !== undefined && invalidDataPasses >= MAX_UNSUPPORTED_HISTORY_PASSES)
          terminal.push(saved);
      }
    }
    if (terminal.length > 0 && sourceFailures === terminal.length && deferredSources === 0) {
      for (const capped of terminal) {
        if (!(await saveGuardianHistoryCheckpoint(context.generation, { ...capped, terminal: true })))
          throw new HistoryInterrupted();
      }
      return { deferred: false, sourceFailures, restored, failed: true, deferredSources };
    }
  } catch (error) {
    // Reported apart from a yield: an evicted run keeps its reservation until the next backend start, as for notes.
    if (isWasmClientPoisonedError(error))
      return { deferred: true, evicted: true, sourceFailures, restored, deferredSources };
    if (error instanceof HistoryInterrupted || error instanceof OperationAbortedError) {
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
