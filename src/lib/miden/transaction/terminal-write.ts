/**
 * How many times to try writing the terminal status of a rotation that has
 * ALREADY committed on chain, and how long to space the attempts. A landed row's
 * Completed write takes the same budget (PR #2183). A module of its own, so a
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
