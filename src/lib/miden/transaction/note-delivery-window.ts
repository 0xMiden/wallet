/**
 * How long after the send a note the transport has not acknowledged is still pushed, in
 * seconds. The output note and its inclusion proof stay in this client's store for good,
 * so age alone never makes a push fail; the bound is how long a send that keeps failing
 * goes on before the history card tells the user retries have stopped.
 *
 * In a module of its own, with no imports, so the history card can read it without
 * pulling in the delivery sweep.
 */
export const RETRY_WINDOW_SECONDS = 72 * 60 * 60;
