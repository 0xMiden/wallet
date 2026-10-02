// Where a landed guardian switch left this device's copy of the account (#1233), and how the switch
// reconcile brings it to the post-switch state before it registers it.
//
// After a failed apply the store still holds the pre-switch account, whose guardian slot names the
// outgoing operator, and the new operator refuses to register that. The outgoing operator holds the
// post-switch state once it canonicalizes the switch delta the wallet pushes after submit, and keeps
// serving reads after it releases the account, so the reconcile adopts from it.

import { getGuardianCommitmentFromAccount } from './account';
import { OUTGOING_GUARDIAN_DEADLINE_MS, withTimeout } from './discover';
import { checkEndpointCommitment } from './operator-map';
import { midenClientProxy } from '../back/miden-client-proxy';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import { isWasmClientPoisonedError, WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';
import { monotonicNowMs } from '../sync-backoff';

/**
 * `'post-switch'`: the local copy names the new guardian's key. `'pre-switch'`: it names another.
 * `'unknown'`: the account, its guardian slot or the new operator's `/pubkey` could not be read.
 */
export type PostSwitchLocalState = 'post-switch' | 'pre-switch' | 'unknown';

/** How long the reconcile waits for the outgoing guardian to hold the post-switch state. */
export const POST_SWITCH_ADOPT_DEADLINE_MS = 75_000;
/** Between adopts: canonicalization runs every 3 s at first and every 10 s after. */
export const POST_SWITCH_ADOPT_POLL_MS = 5_000;
/**
 * The reconcile's `/pubkey` budget for the new operator. It asks once, so a slow operator gets the
 * one-shot budget `USER_ENDPOINT_CHECK_TIMEOUT_MS` has, not the tick's 5 s.
 */
export const POST_SWITCH_RECONCILE_CHECK_TIMEOUT_MS = 20_000;

/** The outgoing guardian the reconcile adopts from: a lock-free read of its answer, and one adopt of its state. */
export interface PostSwitchAdopter {
  probe(timeoutMs: number): Promise<void>;
  adoptOnce(): Promise<void>;
}

/** `timeoutMs` omitted keeps `checkEndpointCommitment`'s tick default, which only a repeating caller can afford. */
export async function readPostSwitchLocalState(
  accountPublicKey: string,
  newGuardianEndpoint: string,
  timeoutMs?: number
): Promise<PostSwitchLocalState> {
  const localGuardian = await withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(accountPublicKey);
      // The account is a borrow of the client this hold owns.
      assertWasmHoldCurrent(hold, 'post-switch state: after the account read');
      return account ? getGuardianCommitmentFromAccount(account) : undefined;
    },
    { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'post-switch-state-read' }
  );
  if (!localGuardian) return 'unknown';
  const verdict = await checkEndpointCommitment(newGuardianEndpoint, localGuardian, timeoutMs);
  if (verdict === 'match') return 'post-switch';
  return verdict === 'mismatch' ? 'pre-switch' : 'unknown';
}

/**
 * Adopt the outgoing guardian's state until the local copy names the new guardian, or the deadline
 * passes. Without an adopter it only reads. `'unknown'` stops at once: the registration that follows
 * then either lands or books its own failure.
 */
export async function adoptPostSwitchState(
  adopter: PostSwitchAdopter | undefined,
  accountPublicKey: string,
  newGuardianEndpoint: string,
  options: { deadlineMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<PostSwitchLocalState> {
  const now = options.now ?? monotonicNowMs;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? POST_SWITCH_ADOPT_DEADLINE_MS);
  for (;;) {
    const state = await readPostSwitchLocalState(
      accountPublicKey,
      newGuardianEndpoint,
      POST_SWITCH_RECONCILE_CHECK_TIMEOUT_MS
    );
    if (state !== 'pre-switch' || !adopter || now() >= deadline) return state;
    // The adopt holds the WASM lock on the sync ceiling, so a silent guardian there ends in a watchdog
    // eviction that poisons the realm's client. Ask it first, outside any lock; the flagged row's
    // self-heal is the retry.
    const probeMs = Math.min(deadline - now(), OUTGOING_GUARDIAN_DEADLINE_MS);
    try {
      await withTimeout(adopter.probe(probeMs), probeMs, 'probing the outgoing guardian');
    } catch (probeError) {
      console.warn('[Guardian] the outgoing guardian did not answer; leaving the copy to the self-heal:', probeError);
      return state;
    }
    try {
      await adopter.adoptOnce();
    } catch (error) {
      // The service is bound to the client the eviction poisoned, so every later adopt fails too.
      if (isWasmClientPoisonedError(error)) return state;
      // Until it canonicalizes, the outgoing guardian holds the pre-switch state, which imports nothing;
      // a refusal or a failed read is the same "not yet".
      console.warn('[Guardian] the outgoing guardian does not hold the post-switch state yet:', error);
    }
    const waitMs = Math.min(options.pollMs ?? POST_SWITCH_ADOPT_POLL_MS, deadline - now());
    if (waitMs > 0) await sleep(waitMs);
  }
}
