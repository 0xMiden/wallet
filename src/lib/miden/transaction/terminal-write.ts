import * as Repo from 'lib/miden/repo';

import { updateTransactionStatus } from './helper';
import { hasLeftQueue, ITransaction, ITransactionStatus } from '../db/types';

/**
 * How many times to try writing the terminal status of a rotation that has
 * ALREADY committed on chain, and how long to space the attempts. A landed row's
 * Completed write takes the same budget (PR #2183), as does the row read that
 * picks a landed row's verdict. A module of its own, so a
 * suite that mocks the completions still hands the landed write its budget.
 *
 * Only reached when the first write already failed, so the cost is paid only on a
 * path that is going wrong. The point of more than one retry is that the failures
 * worth surviving here (an IndexedDB transaction abort under contention) recur
 * immediately and then clear, which is precisely the shape a single immediate
 * retry cannot survive. Small and bounded because the alternative to giving up is
 * not waiting forever: past this the row is reaped into Failed, which for a
 * committed rotation is a lie, so the budget exists to make that outcome rare
 * rather than to eliminate it (see the residual noted at the call site).
 */
export const TERMINAL_STATUS_WRITE_ATTEMPTS = 4;
export const TERMINAL_STATUS_WRITE_BACKOFF_MS = 250;

const backOffAfter = (failedAttempt: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, TERMINAL_STATUS_WRITE_BACKOFF_MS * failedAttempt));

/**
 * Write the Completed status of a row whose write is already on chain, under the budget above. Each attempt reads the
 * row afresh and writes nothing once it has left the queue, so a row another writer finalized is left alone. `values`
 * may be a function of that read, evaluated on each attempt. Never rejects: past the budget the row stays in progress
 * for the reaper, which is still better than writing the opposite status here. Returns the row as read before the
 * write that landed, or undefined when none did. `what` names the row in the log.
 */
export const writeCommittedCompleted = async <K extends keyof ITransaction>(
  txId: string,
  values: Pick<ITransaction, K> | ((row: ITransaction) => Pick<ITransaction, K>),
  what: string
): Promise<ITransaction | undefined> => {
  for (let attempt = 1; attempt <= TERMINAL_STATUS_WRITE_ATTEMPTS; attempt++) {
    try {
      const row = await Repo.transactions.where({ id: txId }).first();
      if (row === undefined || hasLeftQueue(row)) return undefined;
      await updateTransactionStatus(
        txId,
        ITransactionStatus.Completed,
        typeof values === 'function' ? values(row) : values
      );
      return row;
    } catch (writeError) {
      console.warn(
        `Could not record the completed status for the ${what} row (attempt ${attempt}/${TERMINAL_STATUS_WRITE_ATTEMPTS}):`,
        writeError
      );
      if (attempt < TERMINAL_STATUS_WRITE_ATTEMPTS) await backOffAfter(attempt);
    }
  }
  return undefined;
};

/**
 * Read a row whose write is already on chain, under the budget above, for a caller that picks its terminal write from
 * it. Never rejects: a row missing or unread past the budget is undefined, so the caller writes nothing and a row still
 * in progress goes to the reaper, as `writeCommittedCompleted` leaves one. `what` names the row in the log.
 */
export const readRowWithinTerminalBudget = async (txId: string, what: string): Promise<ITransaction | undefined> => {
  for (let attempt = 1; attempt <= TERMINAL_STATUS_WRITE_ATTEMPTS; attempt++) {
    try {
      return await Repo.transactions.where({ id: txId }).first();
    } catch (readError) {
      console.warn(`Could not read the ${what} row (attempt ${attempt}/${TERMINAL_STATUS_WRITE_ATTEMPTS}):`, readError);
      if (attempt < TERMINAL_STATUS_WRITE_ATTEMPTS) await backOffAfter(attempt);
    }
  }
  return undefined;
};
