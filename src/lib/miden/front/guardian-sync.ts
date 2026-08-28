import { isGuardianAuthRejection, MultisigService } from 'lib/miden/guardian';
import {
  getGuardianCommitmentFromAccount,
  getSignerDetailsFromAccount,
  resolveChosenGuardianEndpoint,
  resolveGuardianEndpoint
} from 'lib/miden/guardian/account';
import {
  finalizeDirectGuardianSwitch,
  isGuardianAccountUnknown,
  isGuardianRegistrationPreflightError,
  isGuardianUnreachableError
} from 'lib/miden/guardian/direct-switch';
import { createAttemptLedger, createRateCooldown } from 'lib/miden/guardian/attempt-ledger';
import { checkEndpointCommitment } from 'lib/miden/guardian/operator-map';
import { guardianRetryAfterSec, isGuardianRateLimited } from 'lib/miden/guardian/serialize';
import { isGuardianCanonicalizationError } from 'lib/miden/sdk/sdk-error-code';
import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { isExtension } from 'lib/platform';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import type { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { clearGuardianServiceFor, getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';
import { SELF_HEAL_AUTH_FAILURE_THRESHOLD, SELF_HEAL_COOLDOWN_MS, SELF_HEAL_MAX_ATTEMPTS, type SelfHealOutcome } from './guardian-selfheal';
import {
  guardianSyncFuseKey,
  isSyncFused,
  noteNonEvictionSyncFailure,
  noteSyncSuccess,
  noteSyncWatchdogEviction
} from './sync-fuse';
import { midenClientProxy } from '../back/miden-client-proxy';
import { withWasmClientLock } from '../sdk/miden-client';
import { isSyncWatchdogEviction, WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

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
    useWalletStore.getState().setGuardianEndpoint(accountPublicKey, guardianEndpoint)
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
const selfHealLedger = createAttemptLedger({
  maxAttempts: SELF_HEAL_MAX_ATTEMPTS,
  backoffMs: SELF_HEAL_COOLDOWN_MS,
  curve: 'flat'
});

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
const missingRegistrationLedger = createAttemptLedger({
  maxAttempts: MISSING_REGISTRATION_MAX_ATTEMPTS,
  backoffMs: MISSING_REGISTRATION_BACKOFF_MS,
  curve: 'doubling'
});

/**
 * `Date.now()` before which an account's sync is paused because the guardian
 * rate-limited it. This tick runs every ~3s per account, which makes it by far
 * the guardian's most frequent caller — and it was the ONE caller that ignored a
 * 429 completely. The transaction pipeline requeues on the server's own
 * `Retry-After` and `registerOnGuardianWithRetry` honours it too; this path just
 * logged the error and came back 3 seconds later, sustaining the very condition
 * the guardian was complaining about. Two wallets sharing a runner's IP sit at
 * ~40 requests/minute from this poll alone against a 60/minute cap, so once
 * transaction traffic starts, a 429 storm is self-inflicted and self-feeding.
 */
/** Cooldown when the guardian rate-limits without naming one. */
export const SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS = 30_000;
/** Ceiling on a server-provided cooldown, so one bad header can't park syncing. */
export const SYNC_RATE_LIMIT_MAX_COOLDOWN_MS = 120_000;

// Monotonic deadlines, not wall-clock: the cap is 120s, but a wall-clock deadline survives
// a backward clock correction for the whole size of that correction, so a stale 429 could
// park an account for hours. Same clock the breaker and the fuse use.
const guardianRateLimit = createRateCooldown(
  { floorMs: SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS, capMs: SYNC_RATE_LIMIT_MAX_COOLDOWN_MS },
  monotonicNowMs
);

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
 * Two ways in, and they share an ending: a 401 whose cold re-register budget is
 * spent (or was closed outright because this device was rotated out), and an
 * operator that reports no record of the account after the registration budget
 * is spent. Both are silent otherwise — a 401 and an unknown-account both CLEAR
 * the outage flag, because the server did answer, and neither stamps a sync. So
 * the status derived from those two signals alone read "Checking" forever, next
 * to a "Last sync" row saying the same, on an account that in fact cannot
 * co-sign anything and whose repair has already given up. This is the third
 * signal, and it exists so that state is nameable on screen.
 *
 * Cleared by any successful sync — including the one a manual rotation produces,
 * which is the way out the pill points at.
 */
export function isGuardianUnrepairable(accountPublicKey: string): boolean {
  return unrepairableAccounts.has(accountPublicKey);
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
 *  - `missingRegistrationState` is already keyed by (account, endpoint, guardian
 *    key), so it never inherits in the first place.
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
 * Push a registration to an operator that reports no record of the account.
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
async function attemptMissingRegistrationSelfHeal(account: WalletAccount): Promise<void> {
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
    return;
  }
  if (!endpoint) return;

  // Read once and decide everything from that one snapshot: the budget key, both
  // guards, and (via `finalizeDirectGuardianSwitch`, which re-syncs and re-reads
  // for the bytes it actually pushes) the write itself.
  // Both reads happen INSIDE the one hold, and only plain strings come out.
  // `getGuardianCommitmentFromAccount` and `getSignerDetailsFromAccount` reach
  // into the WASM account handle, so performing them after the hold released
  // raced any queued client operation for the single-threaded client — the
  // `recursive use of an object` failure. `resolveGuardianDrift` already reads
  // its commitment this way; this path was the outlier.
  const snapshot = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
    if (!sdkAccount) return undefined;
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
  });
  if (!snapshot) return;

  const onChainGuardian = snapshot.guardian;
  const healSubject = {
    accountPublicKey: account.publicKey,
    endpoint,
    guardianKey: onChainGuardian ?? 'no-guardian-key'
  };
  const now = Date.now();
  if (!missingRegistrationLedger.mayAttempt(healSubject, now)) {
    // Budget spent on this triple. The operator keeps saying it has no record of
    // an account whose on-chain guardian it is, and this wallet has stopped
    // pushing — a standstill nothing else surfaces, since an unknown-account
    // answer clears the outage flag and stamps no sync.
    if (missingRegistrationLedger.budgetSpent(healSubject)) {
      markGuardianUnrepairable(account.publicKey, 'the operator holds no record of the account');
    }
    return;
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
    return;
  }
  if (!sameCommitment(localHot, onChainHot.commitment)) {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: this device's hot key is no longer ` +
        `the account's on-chain signer (it was rotated to another device).`
    );
    return;
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
    return;
  }
  const endpointHoldsGuardianKey = await checkEndpointCommitment(endpoint, onChainGuardian);
  if (endpointHoldsGuardianKey !== 'match') {
    console.warn(
      `[Guardian Sync] not registering ${account.publicKey} on ${endpoint}: the operator did not confirm the ` +
        `guardian key this device's account state names (${endpointHoldsGuardianKey}), so that state may predate ` +
        `a rotation another device performed.`
    );
    return;
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
    await finalizeDirectGuardianSwitch(account.publicKey, endpoint, zustandProvider);
    attempt.settle('charged');
    clearGuardianServiceFor(account.publicKey);
    console.warn(
      `[Guardian Sync] registered ${account.publicKey} on ${endpoint} after the operator reported no record of it`
    );
  } catch (e) {
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
      return;
    }
    attempt.settle('charged');
    console.warn(
      `[Guardian Sync] could not register ${account.publicKey} on ${endpoint} ` +
        `(attempt ${attempts + 1}/${MISSING_REGISTRATION_MAX_ATTEMPTS}):`,
      e
    );
  }
}

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
/**
 * Bounds for the plain account reads on this path. Reached only from the sync loop, so
 * they get the sync ceiling rather than the five-minute backstop reserved for writes a
 * user is waiting on, and a label so an eviction names them (#777). A single `getAccount`
 * that has not answered in two minutes is parked, not slow.
 */
const GUARDIAN_READ_LOCK_OPTIONS = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-read' };

async function attemptColdReRegisterSelfHeal(account: WalletAccount): Promise<SelfHealOutcome> {
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
    const coldService = await MultisigService.buildColdMultisigService(staleAccount, account, zustandProvider.signWord);
    const adopted = await coldService
      .adoptGuardianStateOnce()
      .then(() => true)
      .catch(e => {
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

    const sdkAccount = await withWasmClientLock(
      async () => midenClientProxy.getAccount(account.publicKey),
      GUARDIAN_READ_LOCK_OPTIONS
    );
    if (!sdkAccount) return 'refused-transiently';

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
    const onChainHot = await withWasmClientLock(async () =>
      getSignerDetailsFromAccount(sdkAccount, false).catch(hotError => {
        console.warn(`[Guardian Sync] could not read the on-chain hot signer for ${account.publicKey}:`, hotError);
        return undefined;
      })
    );
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

    // Counted as an attempt from HERE, before the await: `/configure` may land
    // even if the call then throws or is torn down mid-flight.
    attempted = true;
    await coldService.reRegisterCurrentStateOnGuardian();
    console.warn(`[Guardian Sync] cold re-register self-heal succeeded for ${account.publicKey}`);
  } catch (e) {
    // Guardian still unreachable / rejecting cold — a later tick may retry per
    // the bounded schedule (see decideColdReRegisterSelfHeal).
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
    return (await resolveGuardianEndpoint(current)) === endpoint;
  } catch (resolveError) {
    console.warn(
      `[Guardian Sync] could not confirm the operator for ${accountPublicKey}; not recording this pass`,
      resolveError
    );
    return false;
  }
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
    const syncedAgainst = syncedGuardianEndpoint.get(account.publicKey);
    if (syncedAgainst !== undefined && syncedAgainst !== endpoint) {
      console.warn(
        `[Guardian Sync] ${account.publicKey} now points at ${endpoint || '(none)'} rather than ` +
          `${syncedAgainst || '(none)'} — dropping the previous operator's sync state`
      );
      if (resetEndpointScopedSyncState(account.publicKey)) notifyOutageListeners();
    }
    syncedGuardianEndpoint.set(account.publicKey, endpoint);

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
    await useWalletStore
      .getState()
      .checkGuardianDrift(account.publicKey)
      .catch(driftError => {
        // Best-effort, but not silent. This is the only reconciler for a
        // rotation that committed on chain and lost its endpoint write, and it
        // reaches the network — so a failure here is exactly the kind that
        // repeats every tick while the account looks fine on screen. Swallowed
        // without a word, the one signal that recovery is not running was gone.
        console.warn(`[Guardian Sync] drift reconciliation failed for ${account.publicKey}:`, driftError);
      });

    // Serve this account's own fuse next, for the same reason as the 429 cooldown
    // and one step stronger: a rate limit says "not yet", a lit fuse says "this
    // endpoint took a request and never answered, and the client we would build to
    // ask again parks on it too". Skipping here rather than at the caller is what
    // makes the gate hold on EVERY path into this function — the extension's
    // post-`SyncRequest` trigger reaches it as well, and a caller-side gate covered
    // only the mobile/desktop loop while this producer went on feeding a ledger
    // nobody read there (#777). The key reuses the endpoint resolved above, so the
    // evidence is booked against the operator this lap actually talks to.
    const fuseKey = guardianSyncFuseKey(account.publicKey, endpoint);
    if (isSyncFused(fuseKey)) continue;

    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider, true);
      await service.sync();
      // The one observation that clears this probe's fuse: a guardian sync that went
      // through proves the realm's client is not parked on this path after all.
      noteSyncSuccess(fuseKey);

      // The rotation that landed while this request was open makes the result
      // above a statement about an operator this account no longer points at.
      if (!(await passMayRecord(generation, account.publicKey, endpoint))) continue;

      // Sync succeeded → the account is authorized; clear any accumulated
      // self-heal state so a future divergence starts its persistence count
      // fresh, and stand down the guardian-unreachable prompt.
      consecutiveAuthFailures.delete(account.publicKey);
      selfHealLedger.clearForAccount(account.publicKey);
      consecutiveUnknownAccount.delete(account.publicKey);
      missingRegistrationLedger.clearForAccount(account.publicKey);
      recordSuccessfulGuardianSync(account.publicKey);

      // Self-heal the update_guardian threshold-2 hardening: if a migrated
      // account's original hardening tx was dropped, it would otherwise sit at
      // threshold-1 indefinitely. Idempotent + best-effort; once per session.
      if (!hardeningChecked.has(account.publicKey)) {
        hardeningChecked.add(account.publicKey);
        const { ensureGuardianProcedureThresholds, startBackgroundTransactionProcessing } =
          await import('lib/miden/transaction');
        const hardeningTxId = await ensureGuardianProcedureThresholds(account.publicKey, undefined, zustandProvider);
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
    } catch (error) {
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
      // 401 has PERSISTED (decideColdReRegisterSelfHeal) do we cold-re-register
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
          const outcome = await attemptColdReRegisterSelfHeal(account);
          attempt.settle(
            outcome === 'attempted' ? 'charged' : outcome === 'refused-permanently' ? 'closed' : 'refunded'
          );
          // Budget spent (or closed): the 401 is now permanent as far as this
          // wallet is concerned, and nothing else would ever say so on screen.
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
        const cooldown = Math.min(
          Math.max(askedMs, SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS),
          SYNC_RATE_LIMIT_MAX_COOLDOWN_MS
        );
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
          await attemptMissingRegistrationSelfHeal(account);
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
      if (isSyncWatchdogEviction(error)) {
        noteSyncWatchdogEviction(fuseKey);
      } else {
        noteNonEvictionSyncFailure(fuseKey);
      }
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
