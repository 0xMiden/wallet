/**
 * Client-side ceiling on a DELEGATED prove, after which the wallet stops waiting for the
 * remote prover and proves locally instead.
 *
 * Generous on purpose: a backstop against a prover that has stopped answering, NOT a
 * latency target. It has to sit well above a legitimately slow proof on a loaded machine,
 * because expiring early costs the user the remote wait AND a full local re-prove.
 *
 * Its own module so that `guardian/proof-freshness.ts`, which the transaction constants
 * and the page bundles load, can read it without the SDK client.
 */
export const DELEGATED_PROVE_TIMEOUT_MS = 120_000;
