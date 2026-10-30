import { DELEGATED_PROVE_TIMEOUT_MS } from 'lib/miden/sdk/delegated-prove-timeout';
import { someInCauseChain } from 'lib/miden/sdk/sdk-error-code';
import { WASM_LOCK_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { runningNow, setRunningTimeout } from 'lib/mobile/background-time';

/**
 * Blocks a proof must outlive the chain tip by when it is sent: the node refuses one once `expiration <= tip + 2`, and
 * the POST itself can take two more blocks. A fee faucet with a transfer policy caps a transaction at 20 blocks from
 * its reference block, so on mainnet a proof goes stale 16 blocks, about 48 s, after that block, whatever delta it asked
 * for.
 */
export const SUBMIT_EXPIRY_MARGIN_BLOCKS = 4;

/** Executions one attempt may add after a stale proof. Each is a fresh execute and prove of the same approval. */
export const MAX_PROOF_REEXECUTIONS = 2;

/** Those 16 blocks at 3 s each. A pass at least this slow comes back stale, and the next at its pace would too. */
export const MAINNET_PROOF_WINDOW_MS = 48_000;

/**
 * Running time one attempt's passes may reach in the extension's offscreen document, 20 s short of its 180 s write
 * deadline. A kill reads as an unknown outcome on a transaction nothing sent, so a re-execution starts only if, at the
 * last pass's pace, it ends inside this. That covers one 120 s wait on a silent remote prover, its fallback and one
 * more local pass.
 */
export const OFFSCREEN_PROOF_BUDGET_MS = 160_000;

/**
 * The same bound for the inline leaf on mobile and desktop, where no write deadline runs. What watches that hold is
 * its normal watchdog ledger, and an eviction reads as the same unknown outcome, so this stops 20 s short of that
 * ledger. Local proves count here though the ledger pauses for them, which can only stop an attempt sooner.
 */
export const INLINE_PROOF_BUDGET_MS = WASM_LOCK_WATCHDOG_MS - 20_000;

/** How long a leaf waits to learn the tip, which it does while holding the WASM lock, before it sends unchecked. */
export const CHAIN_TIP_READ_TIMEOUT_MS = 3_000;

/** Every execution an attempt was allowed ended past its submit window. Nothing was sent (#2060). */
export class StaleProofError extends Error {
  readonly errorBeforeSubmit = true;

  constructor() {
    super(`Proof within ${SUBMIT_EXPIRY_MARGIN_BLOCKS} blocks of expiry with no re-execution left in this attempt`);
    this.name = 'StaleProofError';
  }
}

export function isStaleProofError(error: unknown): boolean {
  return someInCauseChain(error, link => link instanceof StaleProofError);
}

export const isProofStale = (expirationBlock: number, tip: number): boolean =>
  expirationBlock <= tip + SUBMIT_EXPIRY_MARGIN_BLOCKS;

/**
 * Tag what a re-execution's sync or execute threw. It left the row on 'proving', where the row alone reads as a failed
 * prove, though no prover ran (#2060). A tag and not a wrapper, since the lock and the classifiers read the error's
 * class. A value that cannot take the property (a frozen error) stays untagged, which only costs the prover copy.
 */
export function markFailedReexecution(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return Object.assign(new Error(String(error), { cause: error }), { failedReexecution: true });
  }
  try {
    Object.assign(error, { failedReexecution: true });
  } catch {
    // Frozen or a hostile proxy: no tag.
  }
  return error;
}

export const isFailedReexecution = (error: unknown): boolean =>
  someInCauseChain(error, link => 'failedReexecution' in link && link.failedReexecution === true);

/**
 * The tip, or undefined when it cannot be learned in time. The timeout abandons a read on an RpcClient of its own, so
 * nothing it leaves running touches the WASM client. A failed read gets one more inside the same bound, because the
 * first request after a resume is the one likely to fail and this check matters most then. A freeze across the read
 * still fails open: the running clock keeps one 5 s pulse of every freeze, which outlasts this bound.
 */
const readTipInTime = (readTip: () => Promise<number>): Promise<number | undefined> =>
  new Promise(resolve => {
    const cancelBound = setRunningTimeout(() => {
      console.warn('[Guardian] chain tip read outlasted its bound; submitting without a freshness check');
      resolve(undefined);
    }, CHAIN_TIP_READ_TIMEOUT_MS);
    (async () => {
      try {
        return await readTip();
      } catch (error) {
        console.warn('[Guardian] chain tip read failed; reading it once more', error);
        return readTip();
      }
    })().then(
      tip => {
        cancelBound();
        resolve(tip);
      },
      error => {
        cancelBound();
        console.warn('[Guardian] chain tip read failed; submitting without a freshness check', error);
        resolve(undefined);
      }
    );
  });

export interface ProofPass {
  /** True on every pass after the first. */
  reexecuting: boolean;
  /** The remote prover cannot help this pass: it failed in this attempt, or one more wait on it cannot pay off. */
  proveLocally: boolean;
  /** This pass's delegated prove failed. Its own fallback still runs. */
  delegatedProveFailed: () => void;
}

interface FreshProofSteps<T> {
  /** Executes at the current tip and proves. */
  executeAndProve: (pass: ProofPass) => Promise<T>;
  /** The proof's expiration, undefined when it has none to judge. */
  expirationBlockOf: (proven: T) => number | undefined;
  readTip: () => Promise<number>;
  /** Throws once the caller's WASM hold is gone. */
  assertLive: () => void;
  /** Running time the leaf's passes may reach before the limit that watches it. */
  budgetMs: number;
}

/**
 * Drive one attempt's execute and prove until its proof can still be accepted, before the attempt records a crossing,
 * so a proof that went stale never counts as sent. A later execution reference block is a later tip, and the
 * co-signatures bind the proposal's own block rather than that one, so the same approval executes again (#2060).
 *
 * An unreadable tip fails open and the proof is sent, since the reconciler still decides whatever the node answers.
 * The tip is read every time: a stall can hide in the client's lagging sync height, which no clock here can see.
 *
 * A delegated prove that fails is waited on once. A remote prover's timeout is more than twice a mainnet proof's
 * window, so a pass behind a silent prover could only come back stale, and every such wait draws on the hold's normal
 * watchdog ledger. A pass's pace is timed from that failure, since the next pass skips the wait.
 *
 * A prover that answered can still stop answering, and a slowing one is how that starts. A re-execution keeps it only
 * if a whole timeout on top of the last pass's pace fits the budget, and only if that pace gave the proof a chance.
 */
export async function withFreshProof<T>({
  executeAndProve,
  expirationBlockOf,
  readTip,
  assertLive,
  budgetMs
}: FreshProofSteps<T>): Promise<T> {
  const startedAt = runningNow();
  let proveLocally = false;
  let paceFrom = startedAt;
  const delegatedProveFailed = () => {
    proveLocally = true;
    paceFrom = runningNow();
  };
  for (let reexecutions = 0; ; reexecutions++) {
    paceFrom = runningNow();
    const proven = await executeAndProve({ reexecuting: reexecutions > 0, proveLocally, delegatedProveFailed });
    const expirationBlock = expirationBlockOf(proven);
    if (expirationBlock === undefined) return proven;
    const tip = await readTipInTime(readTip);
    assertLive();
    if (tip === undefined || !isProofStale(expirationBlock, tip)) return proven;
    const now = runningNow();
    const elapsed = now - startedAt;
    const pace = now - paceFrom;
    if (reexecutions === MAX_PROOF_REEXECUTIONS || elapsed + pace > budgetMs) throw new StaleProofError();
    if (pace >= MAINNET_PROOF_WINDOW_MS || elapsed + DELEGATED_PROVE_TIMEOUT_MS + pace > budgetMs) proveLocally = true;
    console.warn(`[Guardian] proof expires at block ${expirationBlock} with the tip at ${tip}; executing again`);
  }
}
