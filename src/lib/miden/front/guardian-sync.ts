import { classifyGuardianRecovery, noteRecoveryDivergence } from 'lib/miden/back/guardian-recovery-dispatcher';
import { isGuardianAuthRejection, MultisigService } from 'lib/miden/guardian';
import {
  getGuardianCommitmentFromAccount,
  getSignerDetailsFromAccount,
  resolveChosenGuardianEndpoint,
  resolveGuardianEndpoint
} from 'lib/miden/guardian/account';
import { cooldownFor, createAttemptLedger, createRateCooldown } from 'lib/miden/guardian/attempt-ledger';
import {
  finalizeDirectGuardianSwitch,
  isGuardianAccountUnknown,
  isGuardianRegistrationPreflightError,
  isGuardianUnreachableError,
  readDirectSwitchCommitState
} from 'lib/miden/guardian/direct-switch';
import { checkEndpointCommitment } from 'lib/miden/guardian/operator-map';
import { guardianRetryAfterSec, isGuardianRateLimited } from 'lib/miden/guardian/serialize';
import type { TransactionCommitState } from 'lib/miden/sdk/miden-client-interface';
import { isGuardianCanonicalizationError } from 'lib/miden/sdk/sdk-error-code';
import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { isExtension } from 'lib/platform';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import type { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { clearGuardianServiceFor, getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';
import {
  SELF_HEAL_AUTH_FAILURE_THRESHOLD,
  SELF_HEAL_COOLDOWN_MS,
  SELF_HEAL_MAX_ATTEMPTS,
  type SelfHealOutcome
} from './guardian-selfheal';
import {
  guardianDriftFuseKey,
  guardianSyncFuseKey,
  isSyncFused,
  noteNonEvictionSyncFailure,
  noteSyncSuccess,
  noteSyncWatchdogEviction,
  pendingRotationRecheckFuseKey,
  type SyncFuseKey
} from './sync-fuse';
import { midenClientProxy } from '../back/miden-client-proxy';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import {
  isSyncWatchdogEviction,
  isWasmClientPoisonedError,
  WASM_LOCK_SYNC_WATCHDOG_MS
} from '../sdk/wasm-client-poison';

/**
 * Book one failed probe against `key`, splitting on the only question the fuse asks.
 *
 * TWO DIFFERENT PREDICATES for two different decisions, and collapsing them into one
 * is the mistake this helper exists to make impossible. The BREAK wants any poison at
 * all, because what makes continuing unsafe is that the mutex is already a
 * successor's — equally true of a trap. The FUSE wants watchdog evictions only: its
 * claim is "the node took our request and never answered, so replacing the client
 * cannot reach it", and a `realm-error` trap's client is replaced in milliseconds, so
 * it proves nothing about a parked node. Booked on the wide predicate, four traps
 * silenced a healthy operator for half an hour.
 *
 * The other half of the contract is that a non-eviction failure must be REPORTED, not
 * skipped: while unlit it withdraws the evidence (so a producer that only ever adds
 * would fuse permanently on the first four evictions of its life), and while lit it
 * re-arms the deadline (so "one probe per 30 min until one SUCCEEDS" holds).
 */
function noteGuardianProbeFailure(key: SyncFuseKey, error: unknown): void {
  if (isSyncWatchdogEviction(error)) noteSyncWatchdogEviction(key);
  else noteNonEvictionSyncFailure(key);
}

/**
 * Default GuardianAccountProvider backed by the Zustand store. Frontend-only —
 * the SW has no access to Zustand and must supply its own provider instead.
 * Kept in this file (not `guardian-manager.ts`) so backend code that imports the
 * manager doesn't drag `lib/store` into the SW init chain.
 */
export const zustandProvider: GuardianAccountProvider = {
  getAccounts: async () => useWalletStore.getState().accounts,
  getPublicKeyForCommitment: (commitment: string) => useWalletStore.getState().getPublicKeyForCommitment(commitment),
  signWord: (publicKey: string, wordHex: string) => useWalletStore.getState().signWord(publicKey, wordHex),
  persistNewHotKey: (newHotPubKey: string, newHotCiphertext: string) =>
    useWalletStore.getState().persistNewHotKey(newHotPubKey, newHotCiphertext),
  swapHotKey: (accountPublicKey: string, newHotPubKey: string) =>
    useWalletStore.getState().swapHotKey(accountPublicKey, newHotPubKey),
  setGuardianEndpoint: (accountPublicKey: string, guardianEndpoint: string) =>
    useWalletStore.getState().setGuardianEndpoint(accountPublicKey, guardianEndpoint),
  revertGuardianEndpointAfterDiscard: (accountPublicKey: string, discardedEndpoint: string, revertTo: string) =>
    useWalletStore.getState().revertGuardianEndpointAfterDiscard(accountPublicKey, discardedEndpoint, revertTo)
};

/**
 * Sync Guardian state for all Guardian accounts. Called from AutoSync after chain
 * state sync (frontend context only — uses the Zustand-backed provider).
 *
 * Only Guardian accounts that actually carry a `hotPublicKey` are synced:
 * `getOrCreateMultisigService` binds a service against the hot signer and throws
 * without one. Every account lacking a hot key is skipped, which covers:
 *   - rotation-pending accounts (`requiresHotKeyRotation`, adopted via recovery
 *     or flagged by the legacy-Guardian migration) awaiting the Activate Device
 *     Key banner, and
 *   - legacy single-signer Guardian records that haven't been migrated yet —
 *     e.g. the brief window after a wallet UPGRADE (new code, old storage) and
 *     before the forced re-unlock runs `migrateLegacyGuardianAccounts`. Without
 *     this guard those records made the frontend AutoSync throw "missing
 *     hotPublicKey" every ~3s. Skipping them is correct, not a silence: there is
 *     genuinely no hot-bound service to build, and recovery happens via the
 *     migration → banner → activation path, not here.
 * Once a hot key lands (`swapHotKey`), the next sync cycle picks the account up.
 *
 * This also means the `update_guardian` threshold-2 hardening is intentionally
 * NOT applied to hot-key-less accounts here, and that's correct: a pre-activation
 * account has a single on-chain signer (cold), so a 2-of-N procedure threshold
 * is unsatisfiable and would brick guardian changes. The hardening is applied
 * at activation (`completeReplaceHotKeyTransaction`), once the hot signer makes
 * the account 2-of-N. Don't "fix" this filter to harden pre-activation accounts.
 */
// Accounts whose update_guardian hardening we've already verified this session,
// so the self-heal check below runs at most once per account per session.
const hardeningChecked = new Set<string>();

// `consecutiveAuthFailures` counts 401s in a row (reset on any successful
// sync) — the PERSISTENCE gate for the cold re-register self-heal. The bounded
// retry + cooldown behind that gate live in `selfHealLedger` below.
const consecutiveAuthFailures = new Map<string, number>();

/**
 * Cold re-register budget, keyed (account, endpoint): a 401 streak and its
 * spent budget are statements about ONE operator's allowlist. Flat 60s
 * cooldown measured from each attempt's settle; `'refused-permanently'`
 * settles as `'closed'` (this device is provably not the signer — no retry can
 * change that), `'refused-transiently'` as `'refunded'` (never reached the
 * operator; three unlucky local reads must not disable the repair whose budget
 * only a successful sync resets). All of that is the AttemptLedger contract —
 * see `guardian/attempt-ledger.ts` for why it is encoded once.
 */
const selfHealLedger = createAttemptLedger(
  {
    maxAttempts: SELF_HEAL_MAX_ATTEMPTS,
    backoffMs: SELF_HEAL_COOLDOWN_MS,
    curve: 'flat'
  },
  // Monotonic, for the same reason the 429 cooldown is: a wall-clock gap
  // survives a backward clock correction for the whole size of the correction,
  // so one NTP step backwards would postpone every repair by that much. The
  // breaker, the fuse and the rate cooldown all read this clock.
  monotonicNowMs
);

// Missing-registration self-heal state, mirroring the pair above because the
// write it guards is strictly more dangerous than a cold re-register:
// `finalizeDirectGuardianSwitch` hands the operator THIS DEVICE's serialized
// account as the authoritative `initialState`, so a bad push does not merely
// rewrite an allowlist — it replaces the operator's copy of a PRIVATE account's
// state, which no drift check can detect afterwards (the reconciler compares the
// guardian KEY commitment, not the state behind it).
//
// `consecutiveUnknownAccount` counts unknown-account verdicts in a row per
// account (reset by any other outcome, exactly like `consecutiveAuthFailures`).
// The push budget (`missingRegistrationLedger`, declared under its constants
// below) is keyed by what the push would actually WRITE — account, endpoint,
// and the on-chain guardian key the local state names — so a second rotation
// in the same session, to a different operator or back again, arrives with
// its own budget instead of inheriting an exhausted one from the first.
const consecutiveUnknownAccount = new Map<string, number>();

/**
 * Consecutive unknown-account verdicts required before the first registration
 * push.
 *
 * `isGuardianAccountUnknown` deliberately also matches `data_unavailable`,
 * which the operator uses for a state blob it could not produce — a server-side
 * condition that can be transient. Acting on the first occurrence therefore let
 * one bad response trigger an authority-bearing write over the operator's own
 * copy of the account. Three ticks is ~9s of the same verdict, which no blip
 * survives, and the rotation this repairs has already been broken for longer
 * than that.
 */
export const MISSING_REGISTRATION_PERSISTENCE_THRESHOLD = 3;

/** Registration pushes per (account, endpoint, guardian key) triple before giving up. */
export const MISSING_REGISTRATION_MAX_ATTEMPTS = 3;

/**
 * First gap between registration pushes for one triple; doubles per attempt.
 *
 * Bounded retry rather than one attempt per session: the first push can lose to
 * an operator that is briefly refusing writes, and a one-shot spent on that loss
 * left the row `registerFailed` with no later tick willing to try again — the
 * account cannot recover on its own, because the successful sync that re-arms
 * the one-shot is exactly what an unregistered account cannot produce. Three
 * pushes at 60s then 120s spend ~3 minutes; past that the operator is refusing a
 * registration it also says it needs, which another `/configure` will not
 * resolve. The same clock throttles a REFUSED check (see the guards below), so
 * the probes behind them cannot run on the ~3s tick either.
 */
export const MISSING_REGISTRATION_BACKOFF_MS = 60_000;

// Doubling backoff (60s, then 120s — ~3 minutes across the three pushes),
// measured from each attempt's settle so a push that spends minutes in
// `/configure` deadlines still buys its full gap.
/** Node reads per pending rotation before the user is told to intervene. */
export const PENDING_ROTATION_RECHECK_MAX_ATTEMPTS = 15;
/** Gap between rechecks of one pending rotation. */
export const PENDING_ROTATION_RECHECK_BACKOFF_MS = 120_000;
/**
 * Rows this pass will actually take to the node, per account.
 *
 * Not a budget — the per-row budget above is — but a bound on how much ONE tick
 * can cost. Every probed row is a full chain sync, plus an operator round trip
 * when the rotation turns out discarded, and they run serially ahead of the
 * guardian sync every remaining account is still waiting for. Two keeps the
 * common case (one pending rotation, occasionally two) whole while refusing to
 * let an account with a dozen stale rows turn a 3 s tick into minutes.
 */
export const PENDING_ROTATION_ROWS_PER_PASS = 2;

// The W1 exit's budget: a submitted-unconfirmed rotation gets a bounded run of
// node reads (~30 minutes at the flat gap) before the state is surfaced as
// needing the user. Keyed by the ROW id — two pending rotations on one account
// are separate questions to the chain.
const pendingRotationRecheckLedger = createAttemptLedger(
  {
    maxAttempts: PENDING_ROTATION_RECHECK_MAX_ATTEMPTS,
    backoffMs: PENDING_ROTATION_RECHECK_BACKOFF_MS,
    curve: 'flat'
  },
  monotonicNowMs
);

const missingRegistrationLedger = createAttemptLedger(
  {
    maxAttempts: MISSING_REGISTRATION_MAX_ATTEMPTS,
    backoffMs: MISSING_REGISTRATION_BACKOFF_MS,
    curve: 'doubling'
  },
  monotonicNowMs
);

/** Cooldown when the guardian rate-limits without naming one. */
export const SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS = 30_000;
/** Ceiling on a server-provided cooldown, so one bad header can't park syncing. */
export const SYNC_RATE_LIMIT_MAX_COOLDOWN_MS = 120_000;

// Monotonic deadlines, not wall-clock: the cap is 120s, but a wall-clock deadline survives
// a backward clock correction for the whole size of that correction, so a stale 429 could
// park an account for hours. Same clock the breaker and the fuse use.
const GUARDIAN_RATE_LIMIT_BOUNDS = {
  floorMs: SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  capMs: SYNC_RATE_LIMIT_MAX_COOLDOWN_MS
};

/**
 * Per-account pause while the guardian is rate-limiting this wallet.
 *
 * This tick runs every ~3s per account, which makes it by far
 * the guardian's most frequent caller — and it was the ONE caller that ignored a
 * 429 completely. The transaction pipeline requeues on the server's own
 * `Retry-After` and `registerOnGuardianWithRetry` honours it too; this path just
 * logged the error and came back 3 seconds later, sustaining the very condition
 * the guardian was complaining about. Two wallets sharing a runner's IP sit at
 * ~40 requests/minute from this poll alone against a 60/minute cap, so once
 * transaction traffic starts, a 429 storm is self-inflicted and self-feeding.
 */
const guardianRateLimit = createRateCooldown(GUARDIAN_RATE_LIMIT_BOUNDS, monotonicNowMs);

// --- Guardian sync outage (server unreachable / 5xx) -------------------------
//
// Consecutive sync failures that classify as the guardian being DOWN
// (connection refused / DNS / timeout, or any 5xx — `isGuardianUnreachableError`)
// arm a per-account outage flag once they cross the threshold. The home view
// subscribes to it and surfaces a "guardian unreachable" prompt whose CTA
// routes to Rotate Guardian — the direct on-chain switch fallback
// (guardian/direct-switch.ts) makes that rotation work even while the outgoing
// guardian stays down. Any response that proves the server is ALIVE — a
// successful sync, a 401, a 429 — clears the flag; a non-server error (e.g. a
// local WASM failure) resets only the count, so one interleaved local hiccup
// mid-outage doesn't flap the banner off while the server is still down.
//
// Session-local by design: the counter rebuilds in ~threshold × 3s after a
// popup reopen, and a stale flag can't outlive the outage it described.

/** Consecutive down-classified sync failures before the outage flag arms (~3s ticks). */
export const GUARDIAN_SYNC_OUTAGE_THRESHOLD = 6;

const consecutiveServerFailures = new Map<string, number>();
const outageAccounts = new Set<string>();
// Answering, unusable, and out of automatic repairs — see `isGuardianUnrepairable`.
const unrepairableAccounts = new Set<string>();
const outageListeners = new Set<() => void>();

const notifyOutageListeners = (): void => {
  for (const listener of outageListeners) listener();
};

/**
 * When this account's guardian last completed a sync.
 *
 * Guardian Settings used to render its "Last sync" row from the store's
 * `lastSyncedAt`, which is the WALLET-WIDE stamp: it is rewritten on every
 * backend `StateUpdated`, and a healthy chain sync produces those whether or not
 * the guardian answered. So the same screen could show the Offline pill beside a
 * "3s ago" — the pill honest, the row describing a different subsystem's
 * success. A guardian-scoped stamp is the only value that row can be read as
 * meaning.
 *
 * Recorded only on a COMPLETED sync, not on any proof-of-life: a 401 or a 429
 * tells us the operator is up (and does clear the outage flag), but it did not
 * sync anything, and "last sync" advancing while every sync fails is the same
 * lie in a smaller font.
 *
 * Session-local, like the outage flag: it starts empty after a popup reopen and
 * reads as "never" until the first tick lands (~3s). That is a correct statement
 * about this session rather than a persisted claim we cannot substantiate.
 */
const lastGuardianSyncAt = new Map<string, number>();

/**
 * Subscribe to guardian sync-state changes (useSyncExternalStore-compatible).
 *
 * Fires for the outage flag arming/clearing AND for a new successful-sync stamp,
 * so a subscriber reading either sees both. Named for the outage because that
 * was its first reader; the channel is the module's whole sync state.
 */
export function subscribeGuardianSyncOutage(listener: () => void): () => void {
  outageListeners.add(listener);
  return () => {
    outageListeners.delete(listener);
  };
}

/** Is this account's guardian currently flagged as down? */
export function isGuardianSyncOutage(accountPublicKey: string): boolean {
  return outageAccounts.has(accountPublicKey);
}

/** `Date.now()` of this account's last completed guardian sync, if any this session. */
export function getGuardianLastSyncAt(accountPublicKey: string): number | undefined {
  return lastGuardianSyncAt.get(accountPublicKey);
}

/**
 * How old a success stamp may be and still support a claim about NOW.
 *
 * The stamp records a moment; a status pill asserts a present state. Reading the
 * stamp's mere existence as "online" conflated the two, and nothing in this
 * module ever expires it — it is written on a completed sync and deleted only by
 * a rotation. So an account that synced once and then stopped forever read a
 * green "Online" forever, and two reachable paths do exactly that WITHOUT ever
 * arming the outage or unrepairable flags that would otherwise contradict it:
 *
 *  - a sustained 429, which parks the account on `rateLimitedUntil`, CLEARS the
 *    outage flag (the server answered), stamps nothing, and has no budget that
 *    can exhaust into `markGuardianUnrepairable`;
 *  - any sustained non-server error — a local WASM failure, a repeated
 *    `WasmClientPoisonedError` (deliberately not "unreachable"), a service that
 *    cannot be built from local storage — which resets the count and does
 *    nothing else.
 *
 * On the extension a popup reopen resets the module, bounding it to one session;
 * on mobile and desktop the realm is long-lived and it was genuinely unbounded.
 *
 * DERIVED from the rate-limit ceiling rather than picked, because the two have to
 * be ordered and an earlier hand-picked 90s was NOT: it sat above the 30s
 * fallback floor but below `SYNC_RATE_LIMIT_MAX_COOLDOWN_MS`, so a single 429
 * carrying a large `Retry-After` produced exactly the flap this lifetime exists to
 * prevent — the loop parks for 120s by design, the stamp expires at 90s, and
 * Settings flips Online → Checking → Online across one deliberate cooldown. That
 * needed no sustained fault, just one header.
 *
 * The slack on top covers the sync that ENDS the cooldown: the stamp is only
 * refreshed once that round trip completes, and `service.sync()` has no client
 * deadline, so a healthy-but-slow account must not flap either. Still a statement
 * about the present rather than about the session.
 */
export const GUARDIAN_SYNC_STAMP_FRESH_MS = SYNC_RATE_LIMIT_MAX_COOLDOWN_MS + 30_000;

/**
 * Is this account's last completed sync recent enough to describe the present?
 *
 * Deliberately here rather than in the view: the freshness rule belongs with the
 * stamp whose lifetime it defines, so a second consumer cannot pick a different
 * one.
 */
export function isGuardianLastSyncFresh(accountPublicKey: string, now: number = Date.now()): boolean {
  const at = lastGuardianSyncAt.get(accountPublicKey);
  return at !== undefined && now - at <= GUARDIAN_SYNC_STAMP_FRESH_MS;
}

/**
 * The operator is ANSWERING and the account still cannot use it, and the wallet
 * has stopped trying to fix that on its own.
 *
 * THREE ways in, and they share an ending: a 401 whose cold re-register budget
 * is spent (or was closed outright because this device was rotated out), an
 * operator that reports no record of the account after the registration budget
 * is spent, and a submitted rotation the chain never confirmed whose recheck
 * budget is spent. All three are silent otherwise — a 401 and an unknown-account
 * both CLEAR the outage flag, because the server did answer, and neither stamps
 * a sync; an unconfirmed rotation does not even reach the operator. So the
 * status derived from the other signals alone read "Checking" forever, next to
 * a "Last sync" row saying the same, on an account that in fact cannot co-sign
 * anything and whose repair has already given up. This is the third signal, and
 * it exists so that state is nameable on screen.
 *
 * A successful sync clears only the OPERATOR verdicts (`unrepairableAccounts`).
 * It says nothing about whether a rotation committed, so the pending-rotation
 * owners survive it by design and retract only when the row stops being pending
 * — see `pendingRotationExhaustedOwner` below.
 */
export function isGuardianUnrepairable(accountPublicKey: string): boolean {
  if (unrepairableAccounts.has(accountPublicKey)) return true;
  for (const owner of pendingRotationExhaustedOwner.values()) {
    if (owner === accountPublicKey) return true;
  }
  return false;
}

/**
 * ROWS whose submitted-unconfirmed rotation exhausted its recheck budget,
 * mapped to the account that owns them.
 *
 * A SEPARATE ledger from `unrepairableAccounts`, deliberately: that one is a
 * verdict about the OPERATOR and is cleared by any successful guardian sync —
 * but a healthy operator sync answers nothing about whether the CHAIN confirmed
 * the rotation, so this evidence must survive it (the same
 * sibling-success-erases-the-evidence shape as F-137).
 *
 * Keyed by ROW for the same reason the budget is. Keyed by account, one row
 * resolving retired the prompt while a sibling row nothing had answered was
 * still exhausted — the erasure the row-keyed budget was introduced to stop,
 * reappearing one field over in the flag the budget raises.
 */
const pendingRotationExhaustedOwner = new Map<string, string>();

/** Retire every row prompt for an account. True when something was retired. */
function retirePendingRotationPrompts(accountPublicKey: string): boolean {
  let retired = false;
  for (const [rowId, owner] of pendingRotationExhaustedOwner) {
    if (owner === accountPublicKey) {
      pendingRotationExhaustedOwner.delete(rowId);
      retired = true;
    }
  }
  return retired;
}

/**
 * Retire this account's row prompts whose rows are no longer pending.
 *
 * The recheck retires a prompt when it settles that row itself, and retires all
 * of an account's prompts when nothing is pending at all — but a row can also
 * leave the list by a route neither branch sees (deleted, settled by another
 * realm, migrated). With a sibling row keeping the list non-empty, such an entry
 * is unreachable by both, and `isGuardianUnrepairable` scans by VALUE, so one
 * orphan holds the whole account unrepairable for the realm's lifetime.
 */
function prunePendingRotationPrompts(accountPublicKey: string, liveRowIds: ReadonlySet<string>): boolean {
  let pruned = false;
  for (const [rowId, owner] of pendingRotationExhaustedOwner) {
    if (owner === accountPublicKey && !liveRowIds.has(rowId)) {
      pendingRotationExhaustedOwner.delete(rowId);
      pruned = true;
    }
  }
  return pruned;
}

function markGuardianUnrepairable(accountPublicKey: string, reason: string): void {
  if (unrepairableAccounts.has(accountPublicKey)) return;
  console.warn(
    `[Guardian Sync] ${accountPublicKey} cannot use its guardian and automatic repair has stopped (${reason}) — ` +
      `surfacing it on the guardian screen`
  );
  unrepairableAccounts.add(accountPublicKey);
  notifyOutageListeners();
}

function recordGuardianServerFailure(accountPublicKey: string): void {
  const fails = (consecutiveServerFailures.get(accountPublicKey) ?? 0) + 1;
  consecutiveServerFailures.set(accountPublicKey, fails);
  if (fails >= GUARDIAN_SYNC_OUTAGE_THRESHOLD && !outageAccounts.has(accountPublicKey)) {
    console.warn(
      `[Guardian Sync] guardian unreachable for ${accountPublicKey} (${fails} consecutive failures) — surfacing the switch-guardian prompt`
    );
    outageAccounts.add(accountPublicKey);
    notifyOutageListeners();
  }
}

/** The server answered (success, 401, 429) — it is alive, so the outage is over. */
function clearGuardianServerFailures(accountPublicKey: string): void {
  consecutiveServerFailures.delete(accountPublicKey);
  if (outageAccounts.delete(accountPublicKey)) notifyOutageListeners();
}

/**
 * A sync COMPLETED: stand the outage down and stamp the time, in one
 * notification. Kept as one function rather than a clear-then-stamp pair so a
 * subscriber cannot observe the two halves separately (and so a recovering
 * account does not fire two renders for one event).
 */
function recordSuccessfulGuardianSync(accountPublicKey: string): void {
  consecutiveServerFailures.delete(accountPublicKey);
  outageAccounts.delete(accountPublicKey);
  unrepairableAccounts.delete(accountPublicKey);
  lastGuardianSyncAt.set(accountPublicKey, Date.now());
  notifyOutageListeners();
}

/**
 * The endpoint each account was last SYNCED against, so a rotation can be
 * observed and the previous operator's verdicts dropped.
 *
 * Every signal in this module above this line is a statement about one OPERATOR
 * — "answered 6 times in a row with a 5xx", "rejected our signer", "asked to be
 * left alone for 30s", "completed a sync 20s ago" — and every one of them was
 * keyed by ACCOUNT alone. A rotation changes the operator without touching any
 * of them, so the new guardian inherited the old one's record on its first tick:
 * a count left at 5 armed the outage on one blip, a 429 cooldown silenced an
 * operator that never asked for it, and — the one the user actually sees — the
 * old operator's success stamp made Guardian Settings read "Online" for a new
 * guardian that had never answered, which is precisely the unsubstantiated claim
 * `lastGuardianSyncAt`'s own docstring promises it does not make.
 *
 * Two pieces of state are deliberately NOT reset here:
 *  - `missingRegistrationLedger` is already keyed by (account, endpoint,
 *    guardian key), so it never inherits in the first place.
 *  - `hardeningChecked` describes the ACCOUNT's on-chain procedure thresholds,
 *    which a rotation does not change.
 */
const syncedGuardianEndpoint = new Map<string, string>();

/**
 * Drop every verdict that was about the previous operator, and say whether
 * anything a subscriber can see went with it.
 */
function resetEndpointScopedSyncState(accountPublicKey: string): boolean {
  consecutiveServerFailures.delete(accountPublicKey);
  // A 401 streak and a spent cold-re-register budget are both statements about
  // one operator's allowlist. Keeping the budget would be the sharp one: with it
  // spent, the new operator's very first 401 re-marks the account unrepairable
  // on a verdict the old operator earned.
  consecutiveAuthFailures.delete(accountPublicKey);
  selfHealLedger.clearForAccount(accountPublicKey);
  guardianRateLimit.clear(accountPublicKey);
  // The persistence counter goes too, and this is the subtle one. The verdict it
  // counts — "no record of this account" — IS what a rotation with a lost
  // `/configure` produces on the new operator, which is the argument for keeping
  // it. But the threshold does not exist to establish that the account is
  // unregistered; it exists to rule out a TRANSIENT verdict, since
  // `data_unavailable` is a server-side condition that can blip. Two verdicts
  // inherited from the outgoing operator plus one blip from the new one is a
  // single blip authorizing a `/configure` that overwrites the new operator's
  // authoritative copy of a private account's state. The guardian-key guard does
  // not cover this: it proves WHO the operator is, not that its answer persists.
  // The cost of clearing is three ticks (~9s) on a repair for a condition that,
  // as the threshold's own docstring notes, has already been broken far longer.
  consecutiveUnknownAccount.delete(accountPublicKey);
  // These three are the ones on screen, so the caller has to notify when any of
  // them actually changed — a notify on every tick would re-render the pill
  // forever.
  //
  // Each delete is performed BEFORE the results are combined. Chaining them with
  // `||` reads like a predicate and is in fact three mutations, so the operator
  // short-circuited the moment the first one hit: on the primary path this
  // feature exists for — banner arms, user rotates — `outageAccounts` held the
  // account, and the stamp and the unrepairable flag were therefore never
  // dropped. That left the OUTGOING operator's success stamp on an account now
  // pointed at an operator that has never answered, which is F-137's defect
  // reintroduced through F-137's own fix, and it is what
  // `lastGuardianSyncAt`'s docstring promises cannot happen.
  const outageCleared = outageAccounts.delete(accountPublicKey);
  const unrepairableCleared = unrepairableAccounts.delete(accountPublicKey);
  const stampCleared = lastGuardianSyncAt.delete(accountPublicKey);
  return outageCleared || unrepairableCleared || stampCleared;
}

/**
 * Test-only: reset every piece of this module's per-session sync state.
 *
 * EVERY piece, literally — a partial reset is worse than none, because the state
 * it leaves behind is per-account and therefore invisible until some later test
 * happens to reuse an account key, at which point it skips a branch it meant to
 * exercise (`hardeningChecked` is the sharp one: it gates a once-per-session
 * call). Add new module state to this list when you add it.
 *
 * Notifies subscribers unconditionally, so a `useSyncExternalStore` reader that
 * outlives the reset cannot keep a snapshot the module no longer agrees with.
 */
export function __resetGuardianSyncOutageForTest(): void {
  consecutiveServerFailures.clear();
  outageAccounts.clear();
  unrepairableAccounts.clear();
  syncInFlight = undefined;
  consecutiveUnknownAccount.clear();
  consecutiveAuthFailures.clear();
  selfHealLedger.clearAll();
  guardianRateLimit.clearAll();
  hardeningChecked.clear();
  missingRegistrationLedger.clearAll();
  pendingRotationRecheckLedger.clearAll();
  pendingRotationExhaustedOwner.clear();
  lastGuardianSyncAt.clear();
  syncedGuardianEndpoint.clear();
  // Retire any pass still in flight. Clearing `syncInFlight` alone let a running
  // pass outlive the reset and then write to the maps it had just emptied — and
  // its unconditional `finally` cleared the marker belonging to whichever pass
  // started afterwards, so the coalescing this module depends on was off for the
  // rest of the file. The generation makes both conditional on still being the
  // current pass.
  syncGeneration += 1;
  notifyOutageListeners();
}

/**
 * What the rest of the pass needs to know from the recheck.
 *
 * Three separate facts, not one return value with three readings: `pendingRowId`
 * is evidence for the shadow classifier, `evicted` decides whether this pass may
 * take another WASM hold at all, and `bindingChanged` says the endpoint the pass
 * resolved before calling here is now wrong.
 */
type PendingRotationRecheckResult = {
  pendingRowId?: string;
  evicted: boolean;
  bindingChanged: boolean;
};

const NO_RECHECK_RESULT: PendingRotationRecheckResult = { evicted: false, bindingChanged: false };

/**
 * The W1 exit: verify a submitted-unconfirmed rotation against the node until
 * it answers, then settle the row honestly. This was the acknowledged wedge
 * with no owner — a rotation whose commit wait failed completed the row on no
 * evidence, and if it had NOT landed, drift saw baseline == chain (both still
 * the old operator) and reported in-sync forever. The Dexie row is the durable
 * intent; `didDirectSwitchLand`'s node read is the authority; the Seam-C
 * ledger bounds the reads; a spent budget surfaces through the unrepairable
 * prompt rather than going silent.
 *
 * THREE IDENTIFIERS, deliberately not interchangeable: `row.id` is the local
 * Dexie uuid the budget and the settle are keyed by, `row.transactionId` is the
 * on-chain hash the NODE is asked about, and the guardian key is neither. The
 * first version of this loop asked the node about `row.id`, which can only
 * answer 'not-found' — so it never looked, spent its whole budget, and raised
 * an unrepairable prompt that by design no successful sync clears.
 *
 * Timer-driven WASM hold discipline (#777): bounded at the sync ceiling,
 * labeled, gated on and reporting into its own sync-fuse key.
 */
async function runPendingRotationRecheck(
  account: WalletAccount,
  generation: number
): Promise<PendingRotationRecheckResult> {
  // Keyed per account, like every other guardian probe — see
  // `pendingRotationRecheckFuseKey`. The aggregation below books once per CALL, and
  // this function is called once per account, so a bare key let a healthy account's
  // success erase a parked one's evidence on every lap.
  const fuseKey = pendingRotationRecheckFuseKey(account.publicKey);
  try {
    if (isSyncFused(fuseKey)) return NO_RECHECK_RESULT;
    const { listUnconfirmedSwitchRows, resolveUnconfirmedSwitch } = await import('lib/miden/transaction');
    const rows = await listUnconfirmedSwitchRows(account.publicKey);
    if (rows.length === 0) {
      // The question is settled (or never existed) — retire the prompts, and the
      // budgets with them. Rows can also leave this list by being deleted rather
      // than resolved, and a row-keyed entry nothing will ever ask about again
      // would otherwise sit in the ledger for the realm's lifetime.
      pendingRotationRecheckLedger.clearForAccount(account.publicKey);
      if (retirePendingRotationPrompts(account.publicKey)) notifyOutageListeners();
      return NO_RECHECK_RESULT;
    }
    // A prompt whose row has left the unconfirmed list by any route other than
    // this loop settling it — deleted, resolved elsewhere, migrated away — would
    // otherwise hold the whole account unrepairable forever, since the only
    // other retirement is the empty-list branch above and there is a sibling row
    // keeping the list non-empty.
    if (prunePendingRotationPrompts(account.publicKey, new Set(rows.map(row => row.id)))) notifyOutageListeners();
    // Rows still awaiting an answer when this pass ends. Only one of these may
    // be reported as the account's pending rotation.
    const unsettled: string[] = [];
    // At least one node read got through, and none of them evicted. Both halves
    // matter: the fuse's exit is a probe that completed, and this probe is the
    // whole loop, not any single row within it.
    let probeSucceeded = false;
    let probeEvicted = false;
    // The two failure arms, aggregated for the same reason the success is: both
    // of the fuse's failure notes are keyed, and `noteNonEvictionSyncFailure`
    // ZEROES the eviction count, so booking either one per row let one row's
    // outcome erase what the rest of the loop had accumulated.
    let probeWatchdogEvicted = false;
    let probeFailedOtherwise = false;
    // Reported to the CALLER, not just used here. Breaking this row loop only
    // stops the recheck's own holds; the account loop goes on to take several
    // more (drift, the guardian round trip) against the same abandoned client.
    let evicted = false;
    // A rollback landed, so the endpoint this pass resolved before calling us is
    // no longer what the account names.
    let bindingChanged = false;
    // NEWEST FIRST. A rollback chain has to unwind in LIFO order or it unwinds
    // wrong: with A→B and B→C both discarded, taking A→B first finds the account
    // on C and can conclude nothing useful about a rotation two steps back, while
    // taking B→C first restores B and leaves the account exactly where A→B's own
    // rollback expects to find it. `listUnconfirmedSwitchRows` returns Dexie's
    // primary-key order — uuids — so without this the order is arbitrary, and the
    // per-pass cap below would make it a lasting choice rather than a transient
    // one: the two rows it defers are the two it never looks at.
    //
    // `initiatedAt` (seconds) over `completedAt`, which is optional on the row.
    const ordered = [...rows].sort((a, b) => b.initiatedAt - a.initiatedAt);
    // A retired pass must not keep settling rows. This probe writes more durable
    // state than any other arm of the loop — it demotes transaction rows, rolls the
    // account's guardian endpoint back, spends per-row budgets and notifies the
    // outage listeners — and it was the one arm with no generation check at all, so a
    // reset (an endpoint change, a lock recovery) left the old pass free to do every
    // one of those against state the reset had deliberately cleared. Checked inside
    // the loop rather than once, because the awaits within it are where a whole
    // pass's worth of wall clock goes.
    const retired = (): boolean => generation !== syncGeneration;
    // Rows that actually reached the node this pass. Each one costs a full chain
    // sync (`readDirectSwitchCommitState` syncs before it looks) and, on a
    // discarded rotation, an operator round trip on top — all serialized, all
    // ahead of the guardian sync this pass still owes every remaining account.
    // Unbounded, an account carrying a dozen stale rotations turned one tick
    // into minutes of chain syncs. The rows this skips are not dropped: they
    // keep their place in the list and their budget, and the next pass starts
    // where the cooldown lets it.
    let probed = 0;
    for (const row of ordered) {
      // Retired mid-loop: leave the remaining rows unsettled and take no further
      // action on them. They keep their place in the list and their budget, exactly
      // as the per-pass cap leaves the rows it defers, and the pass that replaced
      // this one re-reads them.
      if (retired()) {
        unsettled.push(row.id);
        continue;
      }
      if (probed >= PENDING_ROTATION_ROWS_PER_PASS) {
        unsettled.push(row.id);
        continue;
      }
      // `rowId`, not `guardianKey`: the budget is spent per durable INTENT, and
      // the node read below is keyed on the on-chain hash, which is a different
      // identifier again. Conflating the two is what made this whole exit inert.
      const subject = { accountPublicKey: account.publicKey, rowId: row.id };
      if (!pendingRotationRecheckLedger.mayAttempt(subject)) {
        if (pendingRotationRecheckLedger.budgetSpent(subject) && !pendingRotationExhaustedOwner.has(row.id)) {
          console.warn(
            `[Guardian Sync] ${account.publicKey} has a guardian switch (${row.id}) the chain never confirmed and ` +
              `the recheck budget is spent — surfacing it on the guardian screen`
          );
          pendingRotationExhaustedOwner.set(row.id, account.publicKey);
          notifyOutageListeners();
        }
        // Still unanswered — it is the account's pending rotation even though
        // this pass will not ask about it again.
        unsettled.push(row.id);
        continue;
      }
      const attempt = pendingRotationRecheckLedger.begin(subject);
      let state: TransactionCommitState;
      try {
        // The ON-CHAIN hash, not the Dexie row id. `row.id` is a local uuid;
        // `getTransactionCommitState` matches `tx.id().toHex()`, so a row id
        // could only ever answer 'not-found' — the recheck would burn its whole
        // budget without ever looking, and then raise the exhausted prompt that
        // no successful sync clears.
        if (!row.transactionId) {
          // CLOSED, not refunded: no future tick can give this row a hash (it is
          // stamped once, by the completion that already ran), so retrying is
          // provably futile — which is exactly what `'closed'` means. Closing
          // surfaces the state for manual recovery on the next pass instead of
          // spending 30 minutes of rechecks to reach a conclusion available now.
          attempt.settle('closed');
          unsettled.push(row.id);
          console.warn(
            `[Guardian Sync] ${account.publicKey} has a pending rotation (${row.id}) with no captured transaction ` +
              `id — the node can never be asked about it, so the recheck is closed; the row stays pending and the ` +
              `next pass surfaces it for manual recovery`
          );
          continue;
        }
        probed += 1;
        state = await readDirectSwitchCommitState(row.transactionId, {
          watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
          label: 'pending-rotation-recheck'
        });
        // NOT reported here. This loop takes one hold per row, and a success
        // booked mid-loop zeroes the key a later row's eviction is about to
        // accumulate against — the same erasure a shared fuse key produces,
        // inside one probe. The success is booked once, after the loop.
        probeSucceeded = true;
      } catch (recheckError) {
        // TWO DIFFERENT QUESTIONS, and conflating them left the narrower answer
        // driving the wider decision. The FUSE only wants watchdog evictions —
        // its subject is a parked node, and a WASM trap says nothing about one.
        // The BREAK wants any poison at all, because what makes continuing
        // unsafe is that the mutex is already a successor's, which is equally
        // true of a trap eviction. Classifying the break with the watchdog-only
        // predicate meant a trap fell through to `continue` and the next row
        // took a fresh hold on somebody else's client — the exact double borrow
        // the break exists to prevent.
        const poisoned = isWasmClientPoisonedError(recheckError);
        // AGGREGATED, exactly like the success, and for the same reason spelled
        // out above it. `noteNonEvictionSyncFailure` ZEROES the eviction count
        // while the fuse is unlit, and this key is deliberately shared by every
        // row and every account — so booked per row it erased the evidence a
        // later row, or a later account, was accumulating. With one account's
        // read failing ordinarily and another's evicting, the counter oscillated
        // 0 → 1 → 0 on every lap and the threshold was unreachable: the same
        // defeat-by-ordering that keying the ledger per probe was written to
        // fix, reproduced inside one key. Booked once, after the loop.
        if (isSyncWatchdogEviction(recheckError)) probeWatchdogEvicted = true;
        else probeFailedOtherwise = true;
        // Could not look — that is not a verdict, and not a spent attempt.
        attempt.settle('refunded');
        unsettled.push(row.id);
        // An eviction ABANDONS the hold rather than cancelling it: the corpse is
        // still inside WASM and the mutex has already been handed to a
        // successor. Taking a fresh hold for the next row would be a second
        // borrow of a client somebody else is inside, so the whole pass stops
        // here and the next tick starts from a clean client.
        if (poisoned) {
          probeEvicted = true;
          evicted = true;
          break;
        }
        continue;
      }
      if (state !== 'committed' && state !== 'discarded') {
        // 'pending' / 'not-found': no verdict either way — spend one recheck.
        attempt.settle('charged');
        unsettled.push(row.id);
        continue;
      }
      // Settling the row is a Dexie/vault write, and its failure is NOT the node
      // failing to answer. Folded into the catch above, a storage hiccup
      // refunded the attempt and reported a non-eviction sync failure — which
      // withdraws the successful probe this pass actually made.
      try {
        // The look is done; the WRITES start here, and they are the ones a retired
        // pass must not make. Left unsettled the row stays pending, which is the same
        // outcome as the storage-failure arm below.
        if (retired()) {
          unsettled.push(row.id);
          continue;
        }
        const landed = state === 'committed';
        // THE VAULT FIRST, THEN THE ROW. `resolveUnconfirmedSwitch` is the point
        // of no return: a demoted row answers `'failed'` to `rotationVerdict`
        // and drops out of the unconfirmed list forever, so a rollback attempted
        // after it has no second chance and drift cannot re-derive one. Reverting
        // first is idempotent instead — if the demote fails, the next pass re-reads
        // the same discarded verdict, finds the binding already rolled back
        // (`'superseded'`) and retries only the row write.
        if (!landed) {
          const revertTo = row.extraInputs?.previousGuardianEndpoint;
          if (revertTo === undefined) {
            // A row written before the completion started stamping the previous
            // endpoint. DO NOT DEMOTE IT: the demote is the point of no return,
            // and the rollback it would be spending is the only repair this
            // state has. Drift cannot substitute — its cheap path compares the
            // stored BASELINE against the chain, both of which still name the
            // old operator, so it answers `'in-sync'` without ever reading the
            // endpoint the account is actually bound to. Demoting here left an
            // account pointed at an operator with no on-chain authority, looking
            // healthy on every surface, with nothing left to notice it.
            //
            // Closed rather than charged: no future tick can grow the field a
            // completion that already ran did not write, so thirty minutes of
            // rechecks would reach a conclusion available now. The row stays
            // pending, which is what keeps the prompt up until a human fixes it.
            attempt.settle('closed');
            unsettled.push(row.id);
            console.error(
              `[Guardian Sync] guardian switch ${row.id} was discarded but the row records no previous endpoint — ` +
                `${account.publicKey} may still name an operator with no on-chain authority, and this pass cannot ` +
                `roll it back; leaving the rotation pending and surfacing it for manual recovery`
            );
            continue;
          } else {
            // Conditional on the account still naming THIS rotation's target.
            // Rows are not ordered here, and a rotation can legitimately land
            // during the ≤30 minutes of rechecks — so a discarded A→B must not
            // roll back a committed B→C, and an unconditional force write would.
            const outcome = await zustandProvider.revertGuardianEndpointAfterDiscard?.(
              account.publicKey,
              row.extraInputs.newGuardianEndpoint,
              revertTo
            );
            if (outcome === 'reverted') {
              clearGuardianServiceFor(account.publicKey);
              bindingChanged = true;
              console.warn(
                `[Guardian Sync] pointed ${account.publicKey} back at ${revertTo} after the node discarded ` +
                  `its guardian switch`
              );
            } else if (outcome === 'stale') {
              // CHARGED, not left on the begin stamp. `'stale'` is not only the
              // lost-CAS race it reads like: the rollback also answers `'stale'`
              // whenever it could not READ the evidence — an operator that never
              // responds to the authority check, a commitment the client could
              // not fetch — and for a rotation discarded to a dead endpoint that
              // is the answer on every pass, forever. Unsettled, the budget never
              // moves, so the retry is unbounded AND `budgetSpent` never turns
              // true, which means the manual-recovery prompt this exit exists to
              // raise is unreachable: the account stays bound to an operator with
              // no authority and every surface reads green. Charging bounds the
              // loop and lets exhaustion surface it.
              attempt.settle('charged');
              console.warn(
                `[Guardian Sync] could not roll ${account.publicKey} back off the discarded switch ${row.id} ` +
                  `(binding moved, or the operator could not be checked); leaving the row pending for the next pass`
              );
              unsettled.push(row.id);
              continue;
            }
            // 'superseded' (or no provider): nothing to roll back — something
            // authoritative already moved the binding off this rotation's
            // target, so demoting the row is all that is left.
          }
        }
        await resolveUnconfirmedSwitch(row.id, landed);
        // Only THIS row's budget and THIS row's prompt: the rows on one account
        // are separate questions to the chain, and clearing the account re-armed
        // an exhausted sibling that nothing had answered.
        pendingRotationRecheckLedger.clear(subject);
        if (pendingRotationExhaustedOwner.delete(row.id)) notifyOutageListeners();
        console.warn(
          `[Guardian Sync] pending rotation ${row.id} was ${state} on chain; ` +
            `row ${landed ? 'upgraded' : 'demoted'}`
        );
      } catch (settleError) {
        // The look SUCCEEDED; only the bookkeeping failed. Leave the attempt on
        // its begin stamp (so this does not re-run every 3s) without refunding
        // against the node or touching the fuse, and let the next pass re-read
        // and retry the write.
        unsettled.push(row.id);
        console.warn(`[Guardian Sync] could not settle pending rotation ${row.id} (will retry):`, settleError);
        // The rollback in this arm takes a WASM hold of its own, so an eviction
        // arrives HERE and not in the read's catch above. Unclassified it was the
        // worst of both: the loop went on to take a fresh hold for the next row —
        // the double borrow the eviction plumbing exists to stop — and, because
        // the read had already set `probeSucceeded`, the pass then withdrew the
        // fuse evidence the eviction had just created.
        if (isWasmClientPoisonedError(settleError)) {
          // Reported to the fuse as well, on the same key and by the same rule
          // as the read arm above: a watchdog eviction is the evidence that this
          // node parked our client, and evidence the fuse never hears cannot
          // accumulate to the threshold that stops us re-parking every pass.
          //
          // BOTH ARMS, symmetrically with the read's catch above. Setting only the
          // watchdog flag left a realm-error poison booking NOTHING at all: the
          // watchdog arm below is false, the success arm is suppressed by
          // `probeEvicted`, and with no non-eviction note either the post-loop
          // aggregation fell through all three. A lit fuse then went un-re-armed, so
          // "one probe per 30 min until one SUCCEEDS" stopped holding for the very
          // probe that had just failed.
          if (isSyncWatchdogEviction(settleError)) probeWatchdogEvicted = true;
          else probeFailedOtherwise = true;
          probeEvicted = true;
          evicted = true;
          break;
        }
      }
    }
    // One booking for the whole probe, in the fuse's own order of preference: an
    // eviction is the evidence the fuse exists to accumulate, so it outranks a
    // note that would zero it, and both outrank a success that is not clean.
    if (probeWatchdogEvicted) noteSyncWatchdogEviction(fuseKey);
    else if (probeSucceeded && !probeEvicted) noteSyncSuccess(fuseKey);
    else if (probeFailedOtherwise) noteNonEvictionSyncFailure(fuseKey);
    // A row this pass already settled is NOT pending, and handing its id to the
    // shadow classifier tells it a rotation is outstanding after the chain
    // answered — the same "fact that is not a fact" that made two hardcoded
    // budgets bias the divergence tally the trigger flip reads.
    //
    // An EXHAUSTED row wins the slot over a merely-unsettled one. The classifier
    // gets one row and asks the budget about that row, so with `[fresh,
    // exhausted]` — an order Dexie is free to produce, since the list is not
    // chronological — it would read "budget available" while the account is
    // sitting behind the generic unrepairable prompt, and the divergence this
    // shadow exists to count is exactly that pairing.
    const exhausted = unsettled.find(id => pendingRotationExhaustedOwner.has(id));
    return { pendingRowId: exhausted ?? unsettled[0], evicted, bindingChanged };
  } catch (e) {
    // Best-effort: the recheck must never break the sync loop.
    console.warn(`[Guardian Sync] pending-rotation recheck failed for ${account.publicKey} (non-fatal):`, e);
    // A poison error can reach here too — from the Dexie import, the row list,
    // or anything else on this path that ran under an abandoned client. The
    // caller has to hear about it for the same reason the inner break exists.
    const poisoned = isWasmClientPoisonedError(e);
    // AND SO DOES THE FUSE. Both inner arms book their evidence before breaking;
    // this one reported the eviction upward and told the ledger nothing, so a probe
    // that failed out here neither accumulated toward the threshold nor re-armed a
    // lit fuse. Thin — everything that can genuinely park sits inside the two inner
    // trys, leaving a dynamic import and a Dexie read — but a reporting gap in the
    // arm that catches "anything else" is exactly where a future failure shape would
    // land silently.
    if (poisoned) noteGuardianProbeFailure(fuseKey, e);
    return { evicted: poisoned, bindingChanged: false };
  }
}

/**
 * Push a registration to an operator that reports no record of the account.
 *
 * Returns TRUE when the realm's WASM client was evicted under this attempt, so
 * the caller must stop taking holds for the rest of the pass. Every other
 * outcome — refused, registered, failed — is `false`: they are all reasons to
 * move on to the next account, not to abandon the pass.
 *
 * This is the recovery half of `registerFailed` (see `ISwitchGuardianExtraInputs`).
 * A rotation whose `update_guardian` committed but whose post-commit
 * `/configure` did not land leaves the account in a state no other self-heal can
 * reach: on chain the new operator IS the guardian, so nothing is "drifted" for
 * the drift reconciler to fix, and every guardian-authenticated call fails
 * because the operator holds no state to authenticate against — including the
 * state load that the 401 self-heal's cold service needs before it can
 * re-register.
 *
 * `finalizeDirectGuardianSwitch` is the one registration path with no such
 * precondition: it reads the signer allowlist from the LOCAL account and POSTs
 * `/configure` directly. That is also what makes this the most dangerous write
 * in this module — the POST carries this device's serialized account as the
 * operator's authoritative `initialState` — so it is gated the same way the cold
 * re-register is, plus one guard that path does not need.
 *
 * The caller supplies persistence (the verdict has repeated); this function
 * supplies the bounded/backed-off budget and the three refusals below.
 *
 * The endpoint is the pointer the account CHOSE, which is neither the raw field
 * nor the fully-resolved one. The raw field was wrong: a pre-per-account-endpoint
 * account on a custom operator has the legacy global key as its only pointer,
 * since the unlock backfill leaves that account's field empty rather than
 * stamping a guess — so this refused the repair for exactly the population it
 * serves, and refused it BEFORE `markGuardianUnrepairable` below, leaving the
 * account not merely unrepaired but unnameable (no outage flag, since the
 * operator answered; no sync stamp; no unrepairable flag) which Guardian Settings
 * renders as "Checking" forever. The fully-resolved value would be wrong the
 * other way and far worse: its last arm is the network DEFAULT, and this function
 * POSTs the device's serialized private account state as that operator's
 * authoritative `initialState`. An account with no pointer at all must still
 * refuse. F-150 and F-151 fixed this same field-versus-identity confusion in the
 * sync loop and the drift reconciler; this was the last one.
 */
async function attemptMissingRegistrationSelfHeal(account: WalletAccount, fuseKey: SyncFuseKey): Promise<boolean> {
  // A pointer we could not READ gets the same refusal as no pointer at all, and
  // for the stronger of the two reasons: this function POSTs the device's
  // serialized private account state, so the one thing it must never do is
  // proceed on a guess about which operator is entitled to it. Returning without
  // stamping the attempt budget also keeps a storage hiccup from consuming one of
  // the account's few self-heal attempts — the next tick retries from where it
  // left off rather than a step further along.
  let endpoint: string | undefined;
  try {
    endpoint = await resolveChosenGuardianEndpoint(account);
  } catch (error) {
    console.warn(
      `[GuardianSync] could not read the guardian pointer for ${account.publicKey}; skipping self-heal`,
      error
    );
    return false;
  }
  if (!endpoint) return false;

  // Read once and decide everything from that one snapshot: the budget key, both
  // guards, and (via `finalizeDirectGuardianSwitch`, which re-syncs and re-reads
  // for the bytes it actually pushes) the write itself.
  // Both reads happen INSIDE the one hold, and only plain strings come out.
  // `getGuardianCommitmentFromAccount` and `getSignerDetailsFromAccount` reach
  // into the WASM account handle, so performing them after the hold released
  // raced any queued client operation for the single-threaded client — the
  // `recursive use of an object` failure. `resolveGuardianDrift` already reads
  // its commitment this way; this path was the outlier.
  const readSnapshot = () =>
    withWasmClientLock(async hold => {
      const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
      if (!sdkAccount) return undefined;
      // Both reads below walk the account's storage, which is a borrow of the
      // client the handle came from — so after this parking await they are calls
      // on a client an eviction may already have given to a successor. Both also
      // swallow their own failure, so the double borrow would land as "no
      // commitment" and "no hot signer" rather than as an error.
      assertWasmHoldCurrent(hold, 'guardian missing-registration snapshot, after the account read');
      return {
        guardian: getGuardianCommitmentFromAccount(sdkAccount),
        // Its own failure is still a distinct outcome from "no account": the
        // hot-signer guard below refuses on an unread commitment, so it must be
        // able to tell an absent value from an unreached one.
        hot: await getSignerDetailsFromAccount(sdkAccount, false).catch(hotError => {
          console.warn(`[Guardian Sync] could not read the on-chain hot signer for ${account.publicKey}:`, hotError);
          return undefined;
        })
      };
    }, GUARDIAN_READ_LOCK_OPTIONS);

  // GUARDED, because this hold's eviction is the one the caller most needs to
  // hear about and it had no way to say so. The only other `try` here wraps the
  // `/configure`, so poison from `assertWasmHoldCurrent` threw straight out of
  // the function — past the `Promise<boolean>` = "evicted" contract this
  // signature documents, and out of the account loop's own `catch`, since a
  // throw raised inside a `catch` is not caught by its own `try`. It rejected a
  // promise both callers discard: the pass stopped by accident and the eviction
  // was never booked. An ordinary read failure now refuses instead of taking the
  // rest of the pass down with it.
  let snapshot: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    snapshot = await readSnapshot();
  } catch (snapshotError) {
    if (isWasmClientPoisonedError(snapshotError)) {
      noteGuardianProbeFailure(fuseKey, snapshotError);
      console.warn(
        `[Guardian Sync] the WASM client was evicted reading ${account.publicKey} for the missing-registration ` +
          `self-heal; abandoning the rest of this pass:`,
        snapshotError
      );
      return true;
    }
    console.warn(
      `[Guardian Sync] could not read ${account.publicKey} for the missing-registration self-heal:`,
      snapshotError
    );
    return false;
  }
  if (!snapshot) return false;

  const onChainGuardian = snapshot.guardian;
  const healSubject = {
    accountPublicKey: account.publicKey,
    endpoint,
    guardianKey: onChainGuardian ?? 'no-guardian-key'
  };
  // The ledger's own clock — monotonic — so this explicit stamp cannot disagree
  // with the one `settle` reads when it re-stamps from settle time.
  const now = monotonicNowMs();
  if (!missingRegistrationLedger.mayAttempt(healSubject, now)) {
    // Budget spent on this triple. The operator keeps saying it has no record of
    // an account whose on-chain guardian it is, and this wallet has stopped
    // pushing — a standstill nothing else surfaces, since an unknown-account
    // answer clears the outage flag and stamps no sync.
    if (missingRegistrationLedger.budgetSpent(healSubject)) {
      markGuardianUnrepairable(account.publicKey, 'the operator holds no record of the account');
    }
    return false;
  }

  // Open the attempt BEFORE the guards — `begin` stamps the clock without
  // consuming an attempt. A refusal is not free — the endpoint probe below is
  // an HTTP round trip — and a refusal that left the clock untouched would
  // re-run these checks on every ~3s tick for as long as the condition behind
  // it holds. The attempt count is spent only on a real push, so three
  // transient refusals cannot burn the budget; a guard that returns without
  // settling leaves exactly the begin stamp, which is that contract.
  const attempts = missingRegistrationLedger.attempts(healSubject);
  const attempt = missingRegistrationLedger.begin(healSubject, now);

  // STOP unless this device is PROVABLY still the account's on-chain hot signer
  // — same arbiter, same reasoning as the cold re-register self-heal:
  // `/configure` is account-wide, so a device that was rotated out would revoke
  // the device that now owns the account.
  //
  // Both commitments have to be read, and both reads can fail on their own. A
  // guard over write authority cannot treat "I could not tell" as permission, so
  // an unread commitment refuses exactly like a mismatched one — the same shape
  // as the guardian-key guard below, which refuses `'unreachable'` for the same
  // reason: this write needs positive evidence, and there is always another tick
  // to get it from.
  //
  // Weaker here than in the 401 path, unavoidably: that path adopts the
  // guardian's own copy of the state before reading the signer set, and this
  // operator has no copy to adopt. So this reads whatever slot 0 says in THIS
  // device's account, which cannot show a hot-key rotation performed elsewhere.
  // The residual risk is bounded by the guardian-key guard below — a copy
  // predating the guardian rotation is refused outright — leaving only the narrow
  // window where a copy is current for the guardian rotation yet stale for a
  // later hot-key rotation.
  const onChainHot = snapshot.hot;
  // A record with no hot key never reaches this function — the sync loop filters
  // those accounts out — so the ternary is here for the type, and it refuses on
  // that path too rather than reading an absent key as "no objection".
  const localHot = account.hotPublicKey
    ? await commitmentFromPublicKeyHex(account.hotPublicKey).catch(localError => {
        console.warn(`[Guardian Sync] could not derive this device's hot-key commitment:`, localError);
        return undefined;
      })
    : undefined;
  if (!onChainHot || !localHot) {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: could not read the hot-signer ` +
        `commitment on ${!onChainHot && !localHot ? 'either side' : !onChainHot ? 'chain' : 'this device'}, so ` +
        `this device cannot show it is still the account's signer.`
    );
    return false;
  }
  if (!sameCommitment(localHot, onChainHot.commitment)) {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: this device's hot key is no longer ` +
        `the account's on-chain signer (it was rotated to another device).`
    );
    return false;
  }

  // STOP unless the local state DESCRIBES a rotation to this operator.
  //
  // The extra guard the 401 path does not need. That path re-registers the
  // on-chain signer set and can adopt the guardian's own copy of the state
  // first; here the operator has no copy to adopt, so the only state in
  // existence is this device's — and if this device's copy predates the
  // rotation, pushing it would install a state naming the OLD guardian as the
  // new operator's authoritative one. Guardian accounts are private storage
  // mode, so nothing on chain would ever reveal that, and the drift reconciler
  // compares only the guardian KEY commitment.
  //
  // The guardian key the local state names is exactly the value the operator
  // serves from its unauthenticated `/pubkey`, which is how drift reconciliation
  // pairs an endpoint with a commitment. A stale snapshot names a different key
  // and is refused; silence is refused too, because this write needs positive
  // evidence and the operator answering our sync at all means `/pubkey` should
  // answer as well.
  if (!onChainGuardian) {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: the local account names no guardian key, ` +
        `so there is nothing to check the operator against.`
    );
    return false;
  }
  const endpointHoldsGuardianKey = await checkEndpointCommitment(endpoint, onChainGuardian);
  if (endpointHoldsGuardianKey !== 'match') {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: the operator did not confirm the ` +
        `guardian key this device's account state names (${endpointHoldsGuardianKey}), so that state may predate ` +
        `a rotation another device performed.`
    );
    return false;
  }

  // Charged before the await: an attempt that throws — or that is torn down
  // mid-flight — has still spent one, because `/configure` may have landed.
  // The settle below then re-stamps from when the attempt FINISHED, which is a
  // different time entirely: `finalizeDirectGuardianSwitch` can spend eight
  // 30s `/configure` deadlines plus backoff — minutes — and measuring the next
  // gap from before all of that made the cooldown inert in the one case it
  // exists for. The `MISSING_REGISTRATION_BACKOFF_MS` docstring promises ~3
  // minutes across three pushes; settle-time stamping is what makes that true.
  attempt.chargeEarly();

  try {
    await finalizeDirectGuardianSwitch(account.publicKey, endpoint, zustandProvider, {
      ...GUARDIAN_READ_LOCK_OPTIONS,
      label: 'guardian-missing-registration'
    });
    attempt.settle('charged');
    clearGuardianServiceFor(account.publicKey);
    console.warn(
      `[Guardian Sync] registered ${account.publicKey} on ${endpoint} after the operator reported no record of it`
    );
  } catch (e) {
    if (isWasmClientPoisonedError(e)) {
      // CHARGED, not refunded: an eviction abandons the call, it does not cancel
      // it, so the `/configure` this attempt was preparing may still be in flight
      // and may still land. Refunding would let the next tick prepare a second
      // one. Reported to the caller so the pass stops taking holds — the
      // abandoned call is still inside a client the mutex has already handed on.
      attempt.settle('charged');
      // Booked here, where the error is in hand: only this frame can tell a
      // parked node from a trap, and the caller's break skips its own feed.
      noteGuardianProbeFailure(fuseKey, e);
      console.warn(
        `[Guardian Sync] the WASM client was evicted while registering ${account.publicKey} on ${endpoint} — ` +
          `the attempt is abandoned, not cancelled, so it counts:`,
        e
      );
      return true;
    }
    if (isGuardianRegistrationPreflightError(e)) {
      // Give the attempt back. This failure happened before any `/configure`,
      // so the reason to count it — that the write may have landed — does not
      // apply, and the budget is only refunded by a SUCCESSFUL registration,
      // which a truncated local read is exactly what prevents. Same booking
      // rule as the 401 self-heal's `refused-transiently`; the clock is stamped
      // either way, so this does not re-read on every 3s tick.
      attempt.settle('refunded');
      console.warn(
        `[Guardian Sync] not registering ${account.publicKey} on ${endpoint} yet — the local account state could ` +
          `not be read completely enough to authorize the operator (no attempt spent):`,
        e
      );
      return false;
    }
    attempt.settle('charged');
    console.warn(
      `[Guardian Sync] could not register ${account.publicKey} on ${endpoint} ` +
        `(attempt ${attempts + 1}/${MISSING_REGISTRATION_MAX_ATTEMPTS}):`,
      e
    );
  }
  return false;
}

/**
 * Bounds for the plain account reads on this path. Reached only from the sync loop, so
 * they get the sync ceiling rather than the five-minute backstop reserved for writes a
 * user is waiting on, and a label so an eviction names them (#777). A single `getAccount`
 * that has not answered in two minutes is parked, not slow.
 */
const GUARDIAN_READ_LOCK_OPTIONS = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-read' };

/**
 * Re-register the account's CURRENT on-chain signer set on the guardian,
 * COLD-signed, to repair a stale request-auth allowlist. Cold is a permanent
 * allowlist member (present in any signer set the account has held), so a
 * cold-signed `/configure` authenticates against a stale allowlist and rewrites
 * it to the on-chain set. Reuses the exact machinery the completion path uses
 * (`buildColdMultisigService` → `reRegisterCurrentStateOnGuardian`).
 *
 * The DECISION of whether to run this — persistence (only after the 401 has
 * repeated, via `consecutiveAuthFailures`), bounded retry, and a cooldown (via
 * `selfHealLedger.mayAttempt`) — is made by the caller; this function only
 * performs the attempt and reports what it did as a `SelfHealOutcome`.
 *
 * On guardian v0.16.0 the common post-rotation case never reaches here: the
 * guardian canonicalizes every co-signed delta and RE-DERIVES the allowlist from
 * the on-chain signer set on its own, so a rotation self-syncs the allowlist
 * without any `/configure`. This is therefore defensive — for a genuinely
 * never-registered / never-canonicalized signer set. Idempotent (registers the
 * on-chain state), so a spurious run is harmless.
 */
async function attemptColdReRegisterSelfHeal(account: WalletAccount, fuseKey: SyncFuseKey): Promise<SelfHealOutcome> {
  // Legacy single-key record (pre-migration) has nothing to cold-sign with.
  if (!account.coldPublicKey) return 'refused-permanently';

  let attempted = false;
  try {
    // getAccount needs no syncState here: buildColdMultisigService only reads the
    // COLD commitment (stable across the rotation), and
    // reRegisterCurrentStateOnGuardian re-syncs on its own for the state it
    // pushes. The two lock uses are sequential (this getAccount releases before
    // the cold service acquires), never nested — no reentrancy deadlock.
    const staleAccount = await withWasmClientLock(
      async () => midenClientProxy.getAccount(account.publicKey),
      GUARDIAN_READ_LOCK_OPTIONS
    );
    if (!staleAccount) return 'refused-transiently';

    // ADOPT THE GUARDIAN'S OWN VIEW FIRST — the check below is worthless without it.
    //
    // Guardian accounts are `storageMode: 'private'` (guardian/account.ts), so the
    // account STATE never travels on chain; only its commitment does. A chain sync
    // therefore cannot tell this device that another device rotated the hot key —
    // `getAccount` keeps returning this client's own pre-rotation copy, in which
    // this device is of course still signer 0. That is why the guard below shipped
    // as a no-op: in a real two-device run neither side ever saw the other's
    // rotation, both kept re-registering, and the livelock continued.
    //
    // The guardian is the only holder of the current state, and COLD is a permanent
    // allowlist member — present in every signer set the account has held — so a
    // cold-signed sync authenticates even while this device's hot key is being
    // rejected. `multisig.syncState()` imports the guardian's state only when it is
    // AHEAD of local (`isSafeToOverwriteLocalState`), so a guardian that is merely
    // lagging cannot clobber a local account that is genuinely newer.
    //
    // Deliberately NOT `MultisigService.sync()`: that wrapper's last-resort stage
    // re-registers local state on a lagging guardian, which is the exact push this
    // function has to decide about first.
    // And if that read fails, STOP — with one exception, below. Logging and
    // carrying on would run the guard against this device's own pre-rotation
    // copy — the state in which this device is still signer 0 no matter who
    // actually holds the account — so the guard would pass by construction and
    // the write would go through. That is not the guard degrading, it is the
    // guard inverted: the one case it exists to catch is the one where the local
    // copy is stale, which is the same case where this read failing leaves it
    // stale. Refuse transiently instead; the heal is defensive, the budget is
    // untouched, and there is another tick.
    //
    // THE EXCEPTION is the SDK refusing to import because the incoming state is
    // NOT AHEAD of local (`isSafeToOverwriteLocalState`: a nonce no greater than
    // local, or a commitment that does not match on chain). That is not a failure
    // to look — it is the answer. A device that had been rotated out would be
    // looking at a guardian holding the NEWER state, which imports cleanly; a
    // guardian that is behind or holding a diverged blob is the stale-registration
    // case this whole function exists to repair, and it is repaired by the push
    // below. Refusing here would make the heal unreachable in exactly the state
    // that needs it — the same shape of mistake as swallowing the failure, in the
    // opposite direction.
    // Bounded and labelled, like every other hold this ~3 s loop reaches. Two of them
    // live in here — the cold-commitment read and `MultisigService.init` — and both
    // used to arm at the five-minute backstop while running on the sync cadence. The
    // commitment read is also the one that used to take NO hold at all, so it could
    // run concurrently with another flow's client call.
    const coldService = await MultisigService.buildColdMultisigService(
      staleAccount,
      account,
      zustandProvider.signWord,
      GUARDIAN_READ_LOCK_OPTIONS
    );
    const adopted = await coldService
      .adoptGuardianStateOnce()
      .then(() => true)
      .catch(e => {
        // AN EVICTION IS NOT "could not read the guardian's state". This call
        // takes a WASM hold of its own at the sync ceiling (`guardian-adopt`,
        // guardian/index.ts) and its payload is a network round trip, which makes
        // it the likeliest of this function's four holds to park — yet a local
        // `.catch` was answering for it, so the poison classifier below never saw
        // it. Every symptom that classifier was added to remove survived here: the
        // pass took fresh holds for the next account while the abandoned syncState
        // was still inside WASM, and the loop's fuse feed then classified the
        // ORIGINAL 401 and zeroed the eviction count. Hand it back.
        if (isWasmClientPoisonedError(e)) throw e;
        if (isGuardianCanonicalizationError(e)) {
          console.warn(
            `[Guardian Sync] the guardian's state for ${account.publicKey} is not ahead of local — proceeding to ` +
              `the re-register, which is the repair for exactly that:`,
            e
          );
          return true;
        }
        console.warn(
          `[Guardian Sync] not self-healing ${account.publicKey}: could not read the guardian's state, so this ` +
            `device cannot tell whether it is still the account's signer:`,
          e
        );
        return false;
      });
    if (!adopted) return 'refused-transiently';

    // STOP if this device is no longer the account's hot signer.
    //
    // Re-registering is how a wallet takes the guardian's request-auth back, and
    // `/configure` is account-wide — so an instance that re-registers revokes
    // whatever the other holder of this account had. That is exactly what a
    // recovery does: recovering the seed on a second device rotates the hot key
    // to THAT device, and the first device — still running, still polling — sees
    // 401s and "heals" by taking authorization back, breaking the device that
    // legitimately owns the account now. Both then heal on their own cooldowns
    // and neither converges (the successful sync in between deletes
    // `selfHealState`, so SELF_HEAL_MAX_ATTEMPTS never accumulates and the
    // livelock is unbounded).
    //
    // The on-chain signer set is the arbiter: signer slot 0 is the hot key by
    // convention ([hot, cold] — see guardian/account.ts). If it no longer matches
    // this device's key, this device did not lose authorization to a stale
    // allowlist — it was rotated out, and there is nothing here to repair.
    // Fails CLOSED on an unread commitment, exactly like the missing-registration
    // guard: a guard over write authority cannot treat "I could not tell" as
    // permission. This path is the more dangerous of the two by its own comment
    // above — and it used to skip the comparison entirely whenever either read
    // came back empty, so a transient failure on either side bought the write.
    // There is always another tick.
    //
    // ONE hold for the account read and the signer read derived from it. An
    // `Account` handle is a borrow of the client it came from, not a snapshot, so
    // reading its signer set under a SECOND hold was a call on a client that may
    // have been replaced in between — and this flow owns nothing across that gap,
    // so it is not a yielded holder and the deferred-free machinery does not defer
    // on its behalf. It also failed silently: the inner read swallows its own
    // error, so the double borrow landed as "could not read the hot signer" and
    // the heal quietly refused. Same shape, and same fix, as the
    // missing-registration snapshot. Bounded and labelled for the same reason as
    // every other hold this ~3 s loop takes.
    const onChainHot = await withWasmClientLock(async hold => {
      const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
      if (!sdkAccount) return undefined;
      assertWasmHoldCurrent(hold, 'guardian cold re-register, after the account read');
      return getSignerDetailsFromAccount(sdkAccount, false).catch(hotError => {
        console.warn(`[Guardian Sync] could not read the on-chain hot signer for ${account.publicKey}:`, hotError);
        return undefined;
      });
    }, GUARDIAN_READ_LOCK_OPTIONS);
    const localHot = account.hotPublicKey
      ? await commitmentFromPublicKeyHex(account.hotPublicKey).catch(localError => {
          console.warn(`[Guardian Sync] could not derive this device's hot-key commitment:`, localError);
          return undefined;
        })
      : undefined;
    if (!onChainHot || !localHot) {
      console.warn(
        `[Guardian Sync] not self-healing ${account.publicKey}: could not read the hot-signer commitment on ` +
          `${!onChainHot && !localHot ? 'either side' : !onChainHot ? 'chain' : 'this device'}, so this device ` +
          `cannot show it is still the account's signer.`
      );
      // TRANSIENT: an unreadable commitment is this device failing to look, not a
      // finding about the account. Spending an attempt on it would let three read
      // failures exhaust a budget that can only be reset by a successful sync —
      // which the stale allowlist is precisely what prevents.
      return 'refused-transiently';
    }
    if (!sameCommitment(localHot, onChainHot.commitment)) {
      console.warn(
        `[Guardian Sync] not self-healing ${account.publicKey}: this device's hot key is no longer the ` +
          `account's on-chain signer (it was rotated to another device). Re-registering would revoke ` +
          `the device that now owns the account.`
      );
      // PERMANENT: this device was rotated out, and no later tick changes that.
      // The caller closes the budget on this outcome, which is what stops this
      // from re-reading once a cooldown forever for a repair that cannot apply.
      return 'refused-permanently';
    }

    // Counted as an attempt from the moment the `/configure` is issued, because past
    // that point it may land even if the call then throws or is torn down mid-flight.
    //
    // FROM INSIDE THE CALLEE, not from here. Flipping it before the call charged the
    // operator's budget for everything `reRegisterCurrentStateOnGuardian` does BEFORE
    // it POSTs — an entire WASM hold whose first act is a `syncState()`, the likeliest
    // park on the path and the one an eviction is most likely to interrupt. So an
    // eviction during a local chain sync returned `'evicted'` rather than
    // `'evicted-preflight'` and spent a budget only a successful sync can refill, on
    // an operator that had not been asked for anything. That is the exact mistake the
    // preflight/post split was introduced to fix, surviving one level down.
    await coldService.reRegisterCurrentStateOnGuardian(() => {
      attempted = true;
    });
    console.warn(`[Guardian Sync] cold re-register self-heal succeeded for ${account.publicKey}`);
  } catch (e) {
    // AN EVICTION IS NOT A VERDICT ON THE OPERATOR, and this is the arm where
    // treating it as one did the most damage. Every hold above is on the ~3 s
    // tick against a client the idle loop also parks, so this catch sees real
    // poison; swallowed into `'attempted'` it charged the operator's budget, and
    // three of those called `markGuardianUnrepairable(pk, 'the operator keeps
    // rejecting this device')` about a guardian that never rejected anything —
    // recoverable only by a successful sync the same parked client prevents.
    // Worse, the caller then reached its fuse feed with the original 401 in hand,
    // so `noteNonEvictionSyncFailure` ZEROED the eviction count and the fuse
    // could never light for the wallet's default account type.
    if (isWasmClientPoisonedError(e)) {
      // Booked HERE, where the error itself is in hand, rather than at the
      // caller's break. The caller only learns THAT this evicted, and the fuse
      // needs to know HOW: `noteSyncWatchdogEviction` means "the node took our
      // request and never answered, so replacing the client cannot reach it",
      // which is true of a watchdog eviction and false of a trap — whose client
      // is replaced in milliseconds. Reported from the caller on the wide
      // predicate, four traps fused a healthy operator for half an hour.
      noteGuardianProbeFailure(fuseKey, e);
      console.warn(
        `[Guardian Sync] the WASM client was evicted while cold re-registering ${account.publicKey} — ` +
          `the attempt is abandoned, not cancelled:`,
        e
      );
      // WHICH SIDE OF THE POST. Past `attempted` the `/configure` may still land,
      // so the budget must be charged; before it, nothing was prepared and
      // charging is the "three local read failures disable the repair for good"
      // mistake the transient refusal exists to avoid — made worse by the
      // caller's break, which skips the check that would at least raise a prompt.
      return attempted ? 'evicted' : 'evicted-preflight';
    }
    // Guardian still unreachable / rejecting cold — a later tick may retry per
    // the bounded schedule (see `selfHealLedger`).
    console.warn(`[Guardian Sync] cold re-register self-heal failed for ${account.publicKey}:`, e);
  }
  return attempted ? 'attempted' : 'refused-transiently';
}

/**
 * Coalesces overlapping runs onto the in-flight one. The extension's 3s tick
 * fires `syncGuardianAccounts()` without awaiting it (`useSyncTrigger`), and a
 * guardian request has no client-side deadline, so a slow or hanging operator
 * lets runs stack — and two of this function's own invariants are per-run, not
 * per-account:
 *
 *  - `consecutiveServerFailures` would count CALLERS rather than attempts.
 *    `MultisigService.sync()` returns one shared in-flight promise, so N
 *    overlapping runs all await the same request and all catch the same
 *    rejection, each incrementing the counter. `GUARDIAN_SYNC_OUTAGE_THRESHOLD`
 *    would then arm after fewer than 6 actual failures and the "~threshold × 3s"
 *    cadence documented above would not hold.
 *  - the `rateLimitedUntil` check reads the cooldown at the top of the loop
 *    body, so overlapping runs all read it before any of them writes it and the
 *    429 backoff is bypassed N ways — against an operator that just asked to be
 *    left alone.
 *
 * A dropped overlapping tick costs nothing: the next one is 3 seconds away.
 */
let syncInFlight: Promise<void> | undefined;

/**
 * Bumped whenever the module's state is reset out from under a running pass, so
 * a retired pass can recognise itself as retired.
 *
 * Without it, `syncInFlight = undefined` retired the MARKER while leaving the
 * pass running: the old pass kept writing to maps the reset had emptied, and its
 * `finally` cleared the marker a NEWER pass had installed, disabling coalescing
 * from then on. Both are now conditional on the generation the pass started in.
 */
let syncGeneration = 0;

/**
 * May this pass still record what it just learned about `endpoint`?
 *
 * Checked AFTER the long awaits, because everything before them was decided from
 * a snapshot: the pass reads the account list once, then spends an unbounded
 * amount of time in drift reconciliation and `service.sync()` (a guardian
 * request with no client-side deadline). A user rotation committing during that
 * window replaces the endpoint the pass is talking to, and the verdict in hand
 * is then about an operator this account no longer uses — most visibly a
 * SUCCESS, which would stamp `lastGuardianSyncAt` and report the new guardian as
 * Online on the strength of the old one answering. The endpoint-change check at
 * the top of the next iteration cleans that up, but a tick later, and the whole
 * point of the stamp is that it never states something it cannot substantiate.
 *
 * Also re-checks the generation, which narrows the retired-pass window from a
 * whole account's worth of writes to the individual awaits inside one.
 */
async function passMayRecord(generation: number, accountPublicKey: string, endpoint: string): Promise<boolean> {
  if (generation !== syncGeneration) return false;
  const accounts = await zustandProvider.getAccounts();
  const current = accounts.find(acc => acc.publicKey === accountPublicKey);
  // Gone (account removed mid-pass) counts as "not ours to write".
  if (!current) return false;
  // Resolved for the same reason the detector above resolves: this has to compare
  // the operator the pass actually talked to, not the field that may or may not
  // name it.
  //
  // A failed read answers `false`, which is both the safe answer and the true
  // one: this function's question is "can the pass substantiate that its verdict
  // is about the CURRENT operator", and a pointer it could not read cannot
  // substantiate anything. Swallowing it also matters structurally — one of the
  // two call sites is inside the sync error handler, where a throw would escape
  // the per-account catch entirely.
  try {
    if ((await resolveGuardianEndpoint(current)) !== endpoint) return false;
  } catch (resolveError) {
    console.warn(
      `[Guardian Sync] could not confirm the operator for ${accountPublicKey}; not recording this pass`,
      resolveError
    );
    return false;
  }
  // AGAIN, AFTER THE AWAITS. The check at the top of this function is only as fresh
  // as the moment it ran, and both reads above can yield — so a reset landing
  // between the last of them and this return handed the caller a `true` earned under
  // a generation that no longer exists, and the caller's whole purpose in asking is
  // that it is about to write. Re-reading a module-scoped counter is free, and the
  // window it closes is the one this function exists to narrow.
  return generation === syncGeneration;
}

export function syncGuardianAccounts(): Promise<void> {
  if (syncInFlight === undefined) {
    const generation = syncGeneration;
    syncInFlight = runGuardianAccountsSync(generation).finally(() => {
      // Only the CURRENT pass owns the marker. A retired one clearing it would
      // hand a concurrent successor's slot away.
      if (generation === syncGeneration) syncInFlight = undefined;
    });
  }
  return syncInFlight;
}

async function runGuardianAccountsSync(generation: number): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const guardianAccounts = accounts.filter(acc => acc.type === WalletType.Guardian && Boolean(acc.hotPublicKey));

  if (guardianAccounts.length === 0) return;

  for (const account of guardianAccounts) {
    // Retired mid-pass: stop rather than re-populating state something else has
    // deliberately cleared. Checked per account, which bounds how much a retired
    // pass can write to the account it was already working on.
    if (generation !== syncGeneration) return;

    // A rotation makes every operator-scoped verdict below about the WRONG
    // operator, so it has to be observed before any of them is read or written —
    // ahead of the 429 cooldown in particular, which would otherwise `continue`
    // on the old operator's request and never reach this.
    //
    // RESOLVED, not `account.guardianEndpoint`. The operator the sync actually
    // talks to is whatever `resolveGuardianEndpoint` returns, which falls back to
    // the legacy global key and then to the effective network default — so the raw
    // field is a different value from the operator identity this is tracking, and
    // it was wrong in both directions. The false POSITIVE is the easy one to hit:
    // the unlock-time backfill stamps the per-account endpoint an account was
    // already resolving to, and `'' !== 'https://…'` then fired a "rotation" that
    // threw away a valid sync stamp, the 401 streak and the self-heal budget for
    // an operator that never changed. The false NEGATIVE is the F-137 defect
    // itself, one door further along: an account resolving through the default
    // sees its operator change under a dev-settings endpoint override while the
    // raw field stays `undefined`, so no reset fires at all.
    // Per-account, because a rejection here would otherwise escape the `for` and
    // reject the whole pass — and the pass's only caller discards it
    // (`syncGuardianAccounts().catch(() => {})` in `useSyncTrigger`), so one
    // account's storage hiccup would silently cost EVERY later account its tick,
    // with nothing in the console to say so. The resolver propagates read
    // failures by design (that is what lets the drift reconciler tell "named no
    // operator" from "could not find out"), so the degradation has to be chosen
    // here. `Vault.backfillGuardianEndpoints` isolates per account for the same
    // reason.
    let endpoint: string;
    try {
      endpoint = await resolveGuardianEndpoint(account);
    } catch (resolveError) {
      console.warn(`[Guardian Sync] could not resolve the guardian endpoint for ${account.publicKey}`, resolveError);
      continue;
    }
    // Derived as soon as the endpoint is known, because the arms that report an
    // eviction now START before the gate below: drift and the two self-heals each
    // break out of this loop, and each has to book its evidence itself. The GATE
    // stays where it was — its position in the pass is deliberate — but the key it
    // uses is just a function of the account and the operator this lap talks to.
    const fuseKey = guardianSyncFuseKey(account.publicKey, endpoint);
    const syncedAgainst = syncedGuardianEndpoint.get(account.publicKey);
    if (syncedAgainst !== undefined && syncedAgainst !== endpoint) {
      console.warn(
        `[Guardian Sync] ${account.publicKey} now points at ${endpoint || '(none)'} rather than ` +
          `${syncedAgainst || '(none)'} — dropping the previous operator's sync state`
      );
      if (resetEndpointScopedSyncState(account.publicKey)) notifyOutageListeners();
    }
    syncedGuardianEndpoint.set(account.publicKey, endpoint);

    // The W1 exit runs AHEAD of both gates below on purpose: it talks to the
    // NODE, not the guardian endpoint, so neither a parked operator (the fuse)
    // nor an operator that rate-limited us (the 429 cooldown) says anything
    // about whether the chain confirmed a rotation. Behind the cooldown, an
    // operator returning 429s silenced the one probe that can settle a pending
    // rotation — the same mistake as putting it behind the fuse. It carries its
    // own fuse key and its own per-row budget.
    const recheck = await runPendingRotationRecheck(account, generation);
    // Same rule as the drift arm below, and for the same reason: an eviction
    // hands the mutex to a successor while the abandoned call is still inside
    // WASM, so every hold this pass would take next — drift's account read, the
    // guardian round trip, the self-heal snapshot — is a second borrow. Breaking
    // only the recheck's own row loop left all of those still to come.
    if (recheck.evicted) break;
    // The rollback just repointed the account, so `endpoint` above (and the
    // stamp taken from it) name the operator we just rolled AWAY from. Syncing
    // against it would spend a round trip on the wrong host and book the fuse
    // under the wrong key. Nothing else in this pass is urgent; the next tick
    // resolves the new endpoint cleanly.
    //
    // `syncedGuardianEndpoint` is already set, a few lines up, to the endpoint
    // this pass resolved — and that is correct rather than something the
    // `continue` needs to undo. The rollback IS an operator change, so the next
    // tick resolving a different endpoint and dropping this one's verdicts is
    // the detector doing its job, not a spurious trip.
    if (recheck.bindingChanged) continue;
    const pendingRotationRow = recheck.pendingRowId;

    // Serve the guardian's own cooldown before anything else: a rate-limited
    // account has nothing to gain from another request, and every one we skip is
    // budget the transaction path can use instead. Expiry is lazy, inside the
    // cooldown itself.
    if (guardianRateLimit.isActive(account.publicKey)) continue;

    // Reconcile the guardian POINTER before anything that depends on it, and
    // regardless of whether the guardian round-trip below succeeds.
    //
    // This used to sit after `service.sync()`, inside the success block — which
    // made the reconciler unreachable in exactly the states that need it. A wrong
    // or stale stored endpoint is what drift reconciliation exists to repair, and
    // a wrong endpoint is precisely what makes `getOrCreateMultisigService` /
    // `service.sync()` throw first: the service is built by loading account state
    // FROM the stored endpoint. So the check ran only when the pointer was already
    // good. It needs nothing from the guardian service — just the vault and a
    // local `getAccount`, plus its own bounded endpoint probes — so hoisting it is
    // free and makes the recovery paths the direct switch relies on real.
    //
    // It also stays AHEAD of the fuse gate below on purpose: a lit fuse is a fact
    // about one endpoint, and a repaired pointer changes the endpoint — so drift
    // reconciliation is the fuse's own exit ramp and must not sit behind it.
    //
    // Best-effort: a drift-check failure must never break the sync loop.
    //
    // GATED ON ITS OWN KEY, and that gate is what keeps the break below from
    // being a permanent stop. Drift takes a WASM hold per guardian account per
    // ~3 s tick, ahead of any cooldown of its own, and an eviction under it ends
    // the whole pass — so with nothing to stretch its cadence, one account whose
    // drift read kept parking meant accounts 2..N were never reached again, on
    // any lap, with no observation left anywhere that could clear a fuse. Feeding
    // a ledger this path could not consult is the exact failure the #777 rule
    // names ("a lit fuse buys nothing"). It cannot share the guardian-sync key:
    // that one is gated a hundred lines below, deliberately, because a repaired
    // pointer changes the endpoint and drift is that fuse's exit ramp.
    let driftError: unknown;
    const driftKey = guardianDriftFuseKey(account.publicKey);
    if (!isSyncFused(driftKey)) {
      await useWalletStore
        .getState()
        .checkGuardianDrift(account.publicKey)
        .then(() => {
          // The one observation that clears this probe: a reconciliation that
          // ran to completion proves the realm's client is not parked here.
          noteSyncSuccess(driftKey);
        })
        .catch(error => {
          // Best-effort, but not silent. This is the only reconciler for a
          // rotation that committed on chain and lost its endpoint write, and it
          // reaches the network — so a failure here is exactly the kind that
          // repeats every tick while the account looks fine on screen. Swallowed
          // without a word, the one signal that recovery is not running was gone.
          driftError = error;
          noteGuardianProbeFailure(driftKey, error);
          console.warn(`[Guardian Sync] drift reconciliation failed for ${account.publicKey}:`, error);
        });
    }
    // An eviction is not just another probe failure: the abandoned drift call is
    // still inside WASM and the mutex is already a successor's, so anything this
    // pass does next is a second borrow of somebody else's client. The recheck
    // above breaks out of its row loop for exactly this reason; the account loop
    // owes the same. The next tick starts from a fresh client.
    if (isWasmClientPoisonedError(driftError)) break;

    // SHADOW dispatcher (guardian-recovery-dispatcher.ts): classify this
    // account's facts and count disagreements with what the legacy predicates
    // do. The trigger flip happens only after a release of this reading zero,
    // which is why every fact here has to be REAL: two of the three budgets
    // were once hardcoded `'available'` and no `pendingRotation` was passed at
    // all, so the tally could not observe the states it was counting and read
    // low by construction.
    {
      // Re-read rather than reuse the pass-start snapshot. Two writers have run
      // since it was taken — the recheck's endpoint rollback and drift's apply,
      // both of which move `guardianSyncStatus` — so classifying the snapshot
      // counts divergences against facts the vault no longer holds. An in-memory
      // store read (`useWalletStore.getState().accounts`), so this costs nothing.
      const current = (await zustandProvider.getAccounts()).find(acc => acc.publicKey === account.publicKey) ?? account;
      const shadowRoute = classifyGuardianRecovery({
        syncStatus: current.guardianSyncStatus,
        hasHotKey: Boolean(current.hotPublicKey),
        outage: isGuardianSyncOutage(account.publicKey),
        unrepairable: isGuardianUnrepairable(account.publicKey),
        // The row the recheck above already listed — no second Dexie read, and
        // no chance of the two disagreeing about what is pending this tick.
        ...(pendingRotationRow ? { pendingRotation: { rowId: pendingRotationRow } } : {}),
        budgets: {
          selfHeal: selfHealLedger.budgetSpent({ accountPublicKey: account.publicKey, endpoint })
            ? 'spent'
            : 'available',
          // Narrowed as far as each subject allows. The missing-registration
          // budget is keyed by (account, endpoint, on-chain guardian key) and
          // only the key is out of reach, so it is asked per OPERATOR — asked
          // per account it kept answering "spent" for the operator the account
          // had just rotated to, from a budget belonging to the one it left.
          missingRegistration: missingRegistrationLedger.anySpentForAccount(account.publicKey, endpoint)
            ? 'spent'
            : 'available',
          // The recheck budget is keyed by row, and the row IS in hand — the
          // classifier reads this fact only inside its `pendingRotation` arm, so
          // it is a claim about THAT rotation. Account-wide, one exhausted row
          // reported its sibling exhausted and named the wrong one in the prompt.
          recheck: (
            pendingRotationRow
              ? pendingRotationRecheckLedger.budgetSpent({
                  accountPublicKey: account.publicKey,
                  rowId: pendingRotationRow
                })
              : pendingRotationRecheckLedger.anySpentForAccount(account.publicKey)
          )
            ? 'spent'
            : 'available'
        }
      });
      // A route that names the pending-rotation state specifically, while the
      // only surface that state has is the generic unrepairable prompt. Counted
      // because it is exactly the copy the flip would improve.
      if (shadowRoute.route === 'prompt' && shadowRoute.reason === 'rotation-unconfirmed-exhausted') {
        noteRecoveryDivergence('rotation-unconfirmed-shown-as-generic-unrepairable');
      }
      if (
        shadowRoute.route === 'prompt' &&
        shadowRoute.reason === 'unrepairable-manual' &&
        !isGuardianUnrepairable(account.publicKey)
      ) {
        noteRecoveryDivergence('spent-budget-without-unrepairable-flag');
      }
    }

    // Serve this account's own fuse next, for the same reason as the 429 cooldown
    // and one step stronger: a rate limit says "not yet", a lit fuse says "this
    // endpoint took a request and never answered, and the client we would build to
    // ask again parks on it too". Skipping here rather than at the caller is what
    // makes the gate hold on EVERY path into this function — the extension's
    // post-`SyncRequest` trigger reaches it as well, and a caller-side gate covered
    // only the mobile/desktop loop while this producer went on feeding a ledger
    // nobody read there (#777). The key reuses the endpoint resolved above, so the
    // evidence is booked against the operator this lap actually talks to.
    if (isSyncFused(fuseKey)) continue;

    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider, true);
      await service.sync();

      // The rotation that landed while this request was open makes the result
      // above a statement about an operator this account no longer points at.
      //
      // An `if` rather than the `continue` this used to be, so the fuse booking at
      // the bottom of this block is still reached: the round trip DID go through,
      // and that is the one observation the fuse waits for, whoever the account
      // points at now.
      if (await passMayRecord(generation, account.publicKey, endpoint)) {
        // Sync succeeded → the account is authorized; clear any accumulated
        // self-heal state so a future divergence starts its persistence count
        // fresh, and stand down the guardian-unreachable prompt.
        consecutiveAuthFailures.delete(account.publicKey);
        selfHealLedger.clearForAccount(account.publicKey);
        consecutiveUnknownAccount.delete(account.publicKey);
        missingRegistrationLedger.clearForAccount(account.publicKey);
        recordSuccessfulGuardianSync(account.publicKey);
        await runGuardianHardeningSelfHeal(account);
      }

      // BOOKED LAST, once the WHOLE probe is through — the hardening self-heal above
      // included, because it takes WASM holds of its own (a service build, and
      // `MultisigService.init` behind that). Booked before them, as it was, a lap
      // that evicted under the hardening was still recorded as a clean guardian
      // success: the eviction arm in the catch below duly added its evidence, but
      // this line had already zeroed the counter, so the fuse stood exonerated for
      // the very park it exists to record. Same rule as the recheck's post-loop
      // booking — a probe is through when its LAST hold is.
      noteSyncSuccess(fuseKey);
    } catch (error) {
      // AN EVICTION OUTRANKS THE STALE-PASS GUARD, which is why this arm moved to
      // the TOP of the catch rather than staying in the chain below `passMayRecord`.
      // That guard answers "may this pass still record a verdict about this
      // operator", and its `continue` sent the pass on to the NEXT account — which
      // then took fresh holds while the abandoned call was still inside WASM. Whether
      // the endpoint moved under us has no bearing on the fact that the mutex is
      // already a successor's, so the two questions must not be asked in that order.
      //
      // THE GUARDIAN ROUND TRIP ITSELF EVICTED, or the hardening self-heal did:
      // `service.sync()` builds its service under a frontend hold at the sync
      // ceiling and `ensureGuardianProcedureThresholds` takes two more, so this is a
      // real arm rather than a defensive one — and it was the last of the four that
      // went on to the next account. An eviction says nothing about the server, so
      // the failure counts are cleared like any other local failure; the difference
      // is that the pass stops.
      if (isWasmClientPoisonedError(error)) {
        consecutiveAuthFailures.delete(account.publicKey);
        consecutiveUnknownAccount.delete(account.publicKey);
        consecutiveServerFailures.delete(account.publicKey);
        // Split on the reason, not merely on the class: a trap's client is replaced
        // in milliseconds, so it is not evidence that this operator parked us, and
        // booking it as such fused a healthy endpoint.
        noteGuardianProbeFailure(fuseKey, error);
        console.error(
          `[Guardian Sync] the WASM client was evicted syncing ${account.publicKey}; abandoning the rest of ` +
            `this pass rather than borrowing a client another flow now owns:`,
          error
        );
        break;
      }

      // Same rule as the success path, and it matters just as much here: a
      // failure earned by the outgoing operator must not arm the outage banner,
      // spend a repair budget, or start a 401 streak against the incoming one.
      if (!(await passMayRecord(generation, account.publicKey, endpoint))) continue;

      // An auth rejection (401) means the guardian's request-auth allowlist and
      // this account's hot signer disagree. Evict the cached hot service so the
      // next tick rebuilds against freshly-synced on-chain state. The guardian
      // collapses stale-allowlist, clock-skew, and replay failures into one 401,
      // and on v0.16.0 a co-signed rotation self-syncs the allowlist via
      // canonicalization — so a transient 401 clears on its own. Only after the
      // 401 has PERSISTED (the persistence gate + `selfHealLedger`) do we cold-re-register
      // to repair a genuinely-stale allowlist, and only a bounded number of
      // times.
      if (isGuardianAuthRejection(error)) {
        // A 401 is the server answering — the guardian is up. It also proves the
        // operator HAS this account (it knows the account and rejects the
        // signer), so any unknown-account streak is broken.
        clearGuardianServerFailures(account.publicKey);
        clearGuardianServiceFor(account.publicKey);
        consecutiveUnknownAccount.delete(account.publicKey);
        const fails = (consecutiveAuthFailures.get(account.publicKey) ?? 0) + 1;
        consecutiveAuthFailures.set(account.publicKey, fails);
        const healSubject = { accountPublicKey: account.publicKey, endpoint };
        if (fails >= SELF_HEAL_AUTH_FAILURE_THRESHOLD && selfHealLedger.mayAttempt(healSubject)) {
          // The ledger books the budget against what the attempt DID, not
          // against the fact that it ran: `'attempted'` charges, a permanent
          // refusal (rotated out — no tick will make this apply) closes the
          // budget outright, and a transient refusal that never reached the
          // guardian refunds — three local read failures must not disable the
          // repair for good. Every outcome re-stamps the cooldown from SETTLE
          // time, so a slow `/configure` still buys its full gap and a refusal
          // does not re-read on every 3s tick.
          const attempt = selfHealLedger.begin(healSubject);
          const outcome = await attemptColdReRegisterSelfHeal(account, fuseKey);
          if (outcome === 'evicted' || outcome === 'evicted-preflight') {
            // WHICH SIDE OF THE POST decides the booking. Past the `/configure`
            // an eviction abandons the call without cancelling it, so it may
            // still land and a refund would let the next tick prepare a second
            // one — charge. Before it, nothing was prepared, and charging local
            // read failures against a budget only a successful sync can reset is
            // what the transient refusal exists to prevent. The break below then
            // skips the `budgetSpent` check, so a charged preflight eviction left
            // the account with a spent budget and nothing on screen.
            attempt.settle(outcome === 'evicted' ? 'charged' : 'refunded');
            // The fuse is booked inside the callee, where the error itself is in
            // hand: this loop's own feed is skipped by the break, the `error` it
            // would classify is the 401 rather than the poison, and only the
            // callee can tell a parked node from a trap.
            break;
          }
          attempt.settle(
            outcome === 'attempted' ? 'charged' : outcome === 'refused-permanently' ? 'closed' : 'refunded'
          );
          // Budget spent (or closed): the 401 is now permanent as far as this
          // wallet is concerned, and nothing else would ever say so on screen.
          // Reachable only from outcomes that are ACTUALLY about the operator —
          // `'evicted'` returns above precisely so a local WASM failure cannot
          // reach this line and accuse a healthy guardian.
          if (selfHealLedger.budgetSpent(healSubject)) {
            markGuardianUnrepairable(account.publicKey, 'the operator keeps rejecting this device');
          }
        }
      } else if (isGuardianRateLimited(error)) {
        // Back off for as long as the guardian asked, and say so once rather than
        // every 3s. A 429 is not an auth problem, so the failure count resets —
        // and it proves the server is up, so the outage flag clears too.
        consecutiveAuthFailures.delete(account.publicKey);
        consecutiveUnknownAccount.delete(account.publicKey);
        clearGuardianServerFailures(account.publicKey);
        const askedMs = (guardianRetryAfterSec(error) ?? 0) * 1000;
        // One clamp, shared by the impose and the log line. Computed twice, the
        // log was free to drift from the cooldown actually served — and the log
        // is the only place this number is ever observed.
        const cooldown = cooldownFor(GUARDIAN_RATE_LIMIT_BOUNDS, askedMs);
        guardianRateLimit.impose(account.publicKey, askedMs);
        console.warn(
          `[Guardian Sync] rate limited (429) for ${account.publicKey}; pausing sync for ${Math.round(cooldown / 1000)}s`
        );
        // Reported before the `continue`, like every other failure shape. A 429 is not a
        // success, so it must not leave a LIT fuse un-re-armed: the rate-limit cooldown is
        // 30–120s, so a guardian answering every probe with a 429 would otherwise pull a
        // fused account back onto a two-minute cadence, when the fuse's contract is one
        // probe per 30 minutes until one SUCCEEDS.
        noteNonEvictionSyncFailure(fuseKey);
        continue;
      } else if (isGuardianAccountUnknown(error)) {
        // The operator answered and says it has never heard of this account. The
        // reachable cause is a rotation whose post-commit registration did not
        // land (`registerFailed` on the switch-guardian row): the account's
        // guardian IS this operator on chain, but the operator holds no state for
        // it, so every co-sign will fail until a registration is pushed.
        //
        // The 401 cold-re-register self-heal cannot repair this — it builds a cold
        // MultisigService, which loads state from the guardian and therefore hits
        // the same "no such account". `finalizeDirectGuardianSwitch` is the
        // load-free registration (it derives the signer allowlist from the LOCAL
        // account and POSTs `/configure`), so it is what this branch runs.
        //
        // A server answering is not an outage, so the failure count resets rather
        // than arming the banner.
        //
        // The push waits for the verdict to PERSIST. `data_unavailable` is one of
        // the codes this branch matches and the operator uses it for a state blob
        // it could not produce, which can be transient — and the repair rewrites
        // that operator's authoritative copy of a private account. One bad
        // response must not be able to trigger it.
        consecutiveAuthFailures.delete(account.publicKey);
        clearGuardianServerFailures(account.publicKey);
        const unknownVerdicts = (consecutiveUnknownAccount.get(account.publicKey) ?? 0) + 1;
        consecutiveUnknownAccount.set(account.publicKey, unknownVerdicts);
        if (unknownVerdicts >= MISSING_REGISTRATION_PERSISTENCE_THRESHOLD) {
          // Same stop rule as the recheck and drift arms: an eviction under the
          // self-heal leaves its call abandoned inside a client the mutex has
          // already handed to a successor, so the pass takes no further holds.
          // The fuse is booked inside the callee, where the error is in hand: the
          // feed at the bottom of this catch is skipped by the break, the `error`
          // it would classify is the operator's "unknown account" response rather
          // than the poison — so it would have withdrawn evidence instead of
          // adding it — and only the callee can tell a parked node from a trap.
          if (await attemptMissingRegistrationSelfHeal(account, fuseKey)) break;
        }
      } else {
        // Non-auth error — don't accumulate auth-failure count.
        consecutiveAuthFailures.delete(account.publicKey);
        consecutiveUnknownAccount.delete(account.publicKey);
        if (isGuardianUnreachableError(error)) {
          // Server down (connection refused / timeout / 5xx): count it toward
          // the outage threshold that surfaces the switch-guardian prompt.
          recordGuardianServerFailure(account.publicKey);
        } else {
          // A local failure (e.g. WASM) says nothing about the server: reset
          // the consecutive count, but keep an already-armed outage flag —
          // only a response from the guardian clears it.
          consecutiveServerFailures.delete(account.publicKey);
        }
      }
      // Feed the realm's sync fuse (#777). Guardian sync takes a hold on the SAME
      // WASM client as the idle loop's `syncState`, bounded at the same two-minute
      // ceiling, and it is reached from that same loop — so an unresponsive guardian
      // parks and poisons the client on a two-minute cadence, leaking the client whose
      // fetch never answered, indefinitely. The loop's own counter never saw any of it:
      // this path's failures are swallowed per-account and never reach the catch block
      // that used to own the ledger. Guardian is the wallet's DEFAULT account type, so
      // that was the majority case of the freeze the fuse exists to bound.
      // Feed the realm's sync fuse. All three outcomes, not just the eviction: the
      // ledger is keyed per probe precisely so guardian evidence is withdrawn by a
      // guardian success and by nothing else, and a producer that only ever ADDS would
      // fuse permanently on the first four evictions of its life.
      //
      // Keyed on THIS ACCOUNT. Sharing one guardian key across accounts reproduced the
      // exact defeat-by-ordering the split ledger was written to fix: this loop is
      // sequential, so a healthy sibling's `noteSyncSuccess` erased the parked account's
      // increment inside the same lap and the threshold could never be reached.
      //
      // Only the WITHDRAWING note is possible here, and that is not an oversight.
      // Every arm that can hold poison books its own eviction and `break`s before
      // reaching this line — the arm at the TOP of this catch, and the two
      // self-heals from inside the callee — so `error` at this point is by
      // construction not an eviction. Restating the split here would read as a live
      // choice and invite the opposite conclusion, that this line is the one feeding
      // the fuse's eviction count.
      noteNonEvictionSyncFailure(fuseKey);
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}

/**
 * The `update_guardian` threshold-2 hardening self-heal: if a migrated account's
 * original hardening tx was dropped it would otherwise sit at threshold-1
 * indefinitely. Idempotent, once per session per account.
 *
 * REJECTS ON AN EVICTION AND ON NOTHING ELSE. `ensureGuardianProcedureThresholds` is
 * best-effort about the hardening itself but re-throws `WasmClientPoisonedError`,
 * because it opens with a service build — two holds, reached on any service-cache
 * miss, and a cache miss is exactly what an eviction's generation bump produces. The
 * caller's eviction arm therefore has to be able to see it, which is also why the
 * guardian success is booked after this returns rather than before it runs.
 */
async function runGuardianHardeningSelfHeal(account: WalletAccount): Promise<void> {
  if (hardeningChecked.has(account.publicKey)) return;
  // Marked BEFORE the await, so a second tick cannot enter while this one
  // is still inside — and withdrawn again if the client is evicted under
  // it. "Once per session" is a bound on how often an IDEMPOTENT check
  // re-runs, not a promise that one abandoned attempt retires it: an
  // eviction here means the call never reached a verdict, and leaving the
  // mark would strand a migrated account at threshold-1 for the rest of
  // the session — the exact state this self-heal exists to repair. Only
  // poison withdraws it; an ordinary failure keeps the once-per-session
  // bound rather than re-queuing the check on every 3 s tick.
  hardeningChecked.add(account.publicKey);
  const { ensureGuardianProcedureThresholds, startBackgroundTransactionProcessing } =
    await import('lib/miden/transaction');
  const hardeningTxId = await ensureGuardianProcedureThresholds(
    account.publicKey,
    undefined,
    zustandProvider,
    // Bounded at the sync ceiling: this call is reached from the ~3 s loop, and
    // both of the holds it takes (the account read and `MultisigService.init`)
    // would otherwise arm at the five-minute backstop — five minutes of frozen
    // wallet per lap, four laps to light this account's fuse.
    true
  ).catch(hardeningError => {
    if (isWasmClientPoisonedError(hardeningError)) hardeningChecked.delete(account.publicKey);
    throw hardeningError;
  });
  // The nudge inside `ensureGuardianProcedureThresholds` is
  // `requestSWTransactionProcessing()`, which returns immediately when
  // there is no extension service worker. Off-extension nothing else
  // starts the FIFO loop from this path, so without this the freshly
  // queued `update-procedure-threshold` row would sit Queued for the rest
  // of the session — visible in Activity as a pending entry that never
  // progresses, with the account left un-hardened until the next app
  // launch's OrphanedTransactionRecovery picked it up. Every other enqueue
  // site pairs the nudge with exactly this driver.
  if (hardeningTxId && !isExtension()) {
    startBackgroundTransactionProcessing(useWalletStore.getState().signTransaction, false, zustandProvider);
  }
}
