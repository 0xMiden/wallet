import { GuardianHttpClient, GuardianHttpError } from '@openzeppelin/guardian-client';
import Dexie from 'dexie';

import { reportGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { MIDEN_GUARDIAN_ENDPOINTS } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import type { WalletAccount } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import type { ITransaction } from '../db/types';
import { resolveGuardianEndpoint } from '../guardian/account';
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
import { readGuardianHistoryState, saveGuardianHistoryCheckpoint } from '../guardian/history-storage';
import { db, transactions } from '../repo';
import { canonicalWalletAccountId } from '../sdk/helpers';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

class HistoryInterrupted extends Error {}

export interface GuardianHistoryRecoveryContext {
  createClient: (
    account: WalletAccount,
    endpoint: string
  ) => Promise<{
    guardian: GuardianHttpClient;
    guardianAccountId: string;
  }>;
  shouldYield: () => Promise<string | null>;
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

async function boundedRequest<T>(request: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Guardian history request timed out')), 15_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function historyRequest<T>(request: () => Promise<T>, check: () => Promise<void>): Promise<T> {
  await check();
  try {
    return await boundedRequest(request);
  } catch (error) {
    if (error instanceof GuardianHttpError && error.status < 500 && error.status !== 429) throw error;
    await check();
    return boundedRequest(request);
  }
}

export async function hasFailedGuardianHistory(account: WalletAccount): Promise<boolean> {
  const state = await readGuardianHistoryState();
  const accountId = canonicalWalletAccountId(account.publicKey);
  const network = getEffectiveNetworkName();
  return Object.values(state.checkpoints).some(
    checkpoint =>
      checkpoint.accountId === accountId && checkpoint.network === network && checkpoint.failure === 'fee-metadata'
  );
}

export async function recoverGuardianHistory(account: WalletAccount, context: GuardianHistoryRecoveryContext) {
  if (await hasFailedGuardianHistory(account)) {
    return { deferred: false, sourceFailures: 1, restored: 0, failed: true };
  }
  const network = getEffectiveNetworkName();
  const canonicalAccountId = canonicalWalletAccountId(account.publicKey);
  const initialState = await readGuardianHistoryState();
  const local = await transactions.where('accountId').equals(account.publicKey).toArray();
  const previous: string[] = [];
  for (const row of local) {
    for (const value of [row.extraInputs?.previousGuardianEndpoint, row.extraInputs?.newGuardianEndpoint]) {
      if (typeof value === 'string') previous.push(value);
    }
    if (row.recovery?.network === network) {
      previous.push(...row.recovery.operators);
      const destination = row.recovery.proposal?.newGuardianEndpoint;
      if (destination) previous.push(destination);
    }
  }
  previous.push(
    ...Object.values(initialState.checkpoints)
      .filter(checkpoint => checkpoint.network === network && checkpoint.accountId === canonicalAccountId)
      .map(checkpoint => checkpoint.operator)
  );
  const operators = normalizeHistoryOperators([
    await resolveGuardianEndpoint(account),
    ...(MIDEN_GUARDIAN_ENDPOINTS.get(network) ?? []),
    ...previous
  ]);
  const check = async () => {
    if (await context.shouldYield()) throw new HistoryInterrupted();
    if (network !== getEffectiveNetworkName()) throw new HistoryInterrupted();
    if ((await readGuardianHistoryState()).generation !== initialState.generation) throw new HistoryInterrupted();
  };
  let sourceFailures = 0;
  let restored = local.filter(row => row.recovery?.network === network).length;
  const commitments = new Map<string, string>();
  try {
    for (const operator of operators) {
      const id = historyCheckpointId(network, canonicalAccountId, operator);
      let checkpoint: GuardianHistoryCheckpoint = initialState.checkpoints[id] ?? {
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
      try {
        await check();
        const { guardian, guardianAccountId } = await context.createClient(account, operator);
        while (!checkpoint.completed) {
          await reportGuardianNoteRecoveryProgress({
            accountId: account.publicKey,
            step: 'history',
            operator,
            restored
          });
          const pageCheckpoint = checkpoint;
          const page = await historyRequest(
            () =>
              guardian.getDeltaHistory(guardianAccountId, { limit: 50, cursor: pageCheckpoint.cursor }).catch(error => {
                if (
                  error instanceof GuardianHttpError &&
                  error.code === 'account_not_found' &&
                  !pageCheckpoint.cursor &&
                  pageCheckpoint.restored === 0
                )
                  return { entries: [], nextCursor: undefined };
                throw error;
              }),
            check
          );
          if (page.entries.length > 50)
            throw new GuardianHistoryDataError('Guardian history page exceeds the requested limit');
          if (
            page.nextCursor &&
            (page.nextCursor === checkpoint.cursor || checkpoint.seenCursors.includes(page.nextCursor))
          ) {
            throw new GuardianHistoryDataError('Guardian history cursor repeats');
          }
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
                } else if (
                  match.type === 'consume' &&
                  record.type === 'consume' &&
                  record.recovery?.completeness === 'decoded'
                ) {
                  // Keep local receipt fields and add the retained note links.
                  match.recovery = record.recovery;
                  await transactions.update(match.id, { recovery: record.recovery });
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
            seenCursors: [...checkpoint.seenCursors, ...(checkpoint.cursor ? [checkpoint.cursor] : [])],
            completed: !page.nextCursor,
            restored: checkpoint.restored + added,
            failure: undefined
          };
          if (!(await saveGuardianHistoryCheckpoint(initialState.generation, checkpoint)))
            throw new HistoryInterrupted();
        }
      } catch (error) {
        if (
          error instanceof HistoryInterrupted ||
          error instanceof OperationAbortedError ||
          error instanceof WasmClientPoisonedError
        )
          throw error;
        if (error instanceof GuardianHistoryFeeUnavailableError) {
          await saveGuardianHistoryCheckpoint(initialState.generation, { ...checkpoint, failure: 'fee-metadata' });
          return { deferred: false, sourceFailures: sourceFailures + 1, restored, failed: true };
        }
        sourceFailures++;
        const failure = error instanceof Error ? classifyHistoryFailure(error) : 'invalid-data';
        await saveGuardianHistoryCheckpoint(initialState.generation, { ...checkpoint, failure });
        console.warn(`[GuardianHistory] Source failed (${failure}): ${operator}`, error);
      }
    }
  } catch (error) {
    if (
      error instanceof HistoryInterrupted ||
      error instanceof OperationAbortedError ||
      error instanceof WasmClientPoisonedError
    ) {
      return { deferred: true, sourceFailures, restored };
    }
    throw error;
  }
  return { deferred: false, sourceFailures, restored };
}
