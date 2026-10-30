import { someInCauseChain } from 'lib/miden/sdk/sdk-error-code';
import { setRunningTimeout } from 'lib/mobile/background-time';

/**
 * Blocks a proof must outlive the chain tip by when it is sent: the node refuses one once `expiration <= tip + 2`, and
 * the POST itself can take two more blocks. A fee faucet with a transfer policy caps a transaction at 20 blocks from
 * its reference block, so on mainnet a proof goes stale 16 blocks, about 48 s, after that block, whatever delta it asked
 * for.
 */
export const SUBMIT_EXPIRY_MARGIN_BLOCKS = 4;

/** Executions one attempt may add after a stale proof. Each is a fresh execute and prove of the same approval. */
export const MAX_PROOF_REEXECUTIONS = 2;

/** How long a leaf waits to learn the tip, which it does while holding the WASM lock, before it sends unchecked. */
export const CHAIN_TIP_READ_TIMEOUT_MS = 3_000;

/** Every execution an attempt was allowed ended past its submit window. Nothing was sent (#2060). */
export class StaleProofError extends Error {
  readonly errorBeforeSubmit = true;

  constructor() {
    super(`Proof within ${SUBMIT_EXPIRY_MARGIN_BLOCKS} blocks of expiry after ${MAX_PROOF_REEXECUTIONS} re-executions`);
    this.name = 'StaleProofError';
  }
}

export function isStaleProofError(error: unknown): boolean {
  return someInCauseChain(error, link => link instanceof StaleProofError);
}

export const isProofStale = (expirationBlock: number, tip: number): boolean =>
  expirationBlock <= tip + SUBMIT_EXPIRY_MARGIN_BLOCKS;

/**
 * The tip, or undefined when it cannot be learned in time. The bound runs on running time so a freeze does not spend
 * it. The timeout abandons a read on an RpcClient of its own, so nothing it leaves running touches the WASM client.
 */
const readTipInTime = (readTip: () => Promise<number>): Promise<number | undefined> =>
  new Promise(resolve => {
    const cancelBound = setRunningTimeout(() => {
      console.warn('[Guardian] chain tip read outlasted its bound; submitting without a freshness check');
      resolve(undefined);
    }, CHAIN_TIP_READ_TIMEOUT_MS);
    (async () => readTip())().then(
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

interface FreshProofSteps<T> {
  /** Executes at the current tip and proves. `reexecuting` is true on every call after the first. */
  executeAndProve: (reexecuting: boolean) => Promise<T>;
  /** The proof's expiration, undefined when it has none to judge. */
  expirationBlockOf: (proven: T) => number | undefined;
  readTip: () => Promise<number>;
  /** Throws once the caller's WASM hold is gone. */
  assertLive: () => void;
}

/**
 * Drive one attempt's execute and prove until its proof can still be accepted, before the attempt records a crossing,
 * so a proof that went stale never counts as sent. A later execution reference block is a later tip, and the
 * co-signatures bind the proposal's own block rather than that one, so the same approval executes again (#2060).
 *
 * An unreadable tip fails open and the proof is sent, since the reconciler still decides whatever the node answers.
 * The tip is read every time: a stall can hide in the client's lagging sync height, which no clock here can see.
 */
export async function withFreshProof<T>({
  executeAndProve,
  expirationBlockOf,
  readTip,
  assertLive
}: FreshProofSteps<T>): Promise<T> {
  for (let reexecutions = 0; ; reexecutions++) {
    const proven = await executeAndProve(reexecutions > 0);
    const expirationBlock = expirationBlockOf(proven);
    if (expirationBlock === undefined) return proven;
    const tip = await readTipInTime(readTip);
    assertLive();
    if (tip === undefined || !isProofStale(expirationBlock, tip)) return proven;
    if (reexecutions === MAX_PROOF_REEXECUTIONS) throw new StaleProofError();
    console.warn(`[Guardian] proof expires at block ${expirationBlock} with the tip at ${tip}; executing again`);
  }
}
