import { isGuardianAuthRejection, MultisigService } from 'lib/miden/guardian';
import { getSignerDetailsFromAccount } from 'lib/miden/guardian/account';
import { finalizeDirectGuardianSwitch, isGuardianUnreachableError } from 'lib/miden/guardian/direct-switch';
import { guardianRetryAfterSec, isGuardianRateLimited } from 'lib/miden/guardian/serialize';
import { isExtension } from 'lib/platform';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import type { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { clearGuardianServiceFor, getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';
import { decideColdReRegisterSelfHeal, type SelfHealAttemptState } from './guardian-selfheal';
import { midenClientProxy } from '../back/miden-client-proxy';
import { withWasmClientLock } from '../sdk/miden-client';

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

// Per-account self-heal state. `consecutiveAuthFailures` counts 401s in a row
// (reset on any successful sync); `selfHealState` tracks attempt count + last
// attempt time. The gating decision (persistence + bounded retry + cooldown)
// lives in decideColdReRegisterSelfHeal (guardian-selfheal.ts, unit-tested).
const consecutiveAuthFailures = new Map<string, number>();
const selfHealState = new Map<string, SelfHealAttemptState>();

// Accounts this session has already tried to re-register on an operator that
// reported never having seen them. Bounded to one attempt per session on
// purpose: `/configure` is account-wide and revokes whatever request-auth the
// account previously had, so retrying it on a 3s tick against an operator that
// keeps saying "unknown account" would hammer a write with real authority on the
// strength of a verdict that is not changing. Cleared on a successful sync, so a
// genuine later recurrence gets a fresh attempt.
const missingRegistrationHealed = new Set<string>();

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
const rateLimitedUntil = new Map<string, number>();

/** Cooldown when the guardian rate-limits without naming one. */
export const SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS = 30_000;
/** Ceiling on a server-provided cooldown, so one bad header can't park syncing. */
export const SYNC_RATE_LIMIT_MAX_COOLDOWN_MS = 120_000;

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
  lastGuardianSyncAt.set(accountPublicKey, Date.now());
  notifyOutageListeners();
}

/**
 * Test-only: reset every piece of this module's per-session sync state — the
 * outage flag and its counter, the in-flight coalescing promise, the
 * one-attempt-per-session registration heal, and the last-sync stamps. Notifies
 * subscribers unconditionally, so a `useSyncExternalStore` reader that outlives
 * the reset cannot keep a snapshot the module no longer agrees with.
 */
export function __resetGuardianSyncOutageForTest(): void {
  consecutiveServerFailures.clear();
  outageAccounts.clear();
  syncInFlight = undefined;
  missingRegistrationHealed.clear();
  lastGuardianSyncAt.clear();
  notifyOutageListeners();
}

/**
 * The operator answered, and its answer is "I have no record of this account".
 *
 * Distinct from a 401, which means "I know this account but not this signer" —
 * the two need different repairs, and conflating them is why the missing
 * registration had none. Matched on the guardian's stable machine-readable codes
 * rather than on text; `data_unavailable` and its account-scoped sibling are
 * included because the server uses them for a state blob it cannot produce,
 * which is the same practical condition.
 */
function isGuardianAccountUnknown(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? err.code : undefined;
  return (
    code === 'account_not_found' ||
    code === 'state_not_found' ||
    code === 'account_data_unavailable' ||
    code === 'data_unavailable'
  );
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
 * `/configure` directly.
 */
async function attemptMissingRegistrationSelfHeal(account: WalletAccount): Promise<void> {
  if (missingRegistrationHealed.has(account.publicKey)) return;
  const endpoint = account.guardianEndpoint;
  if (!endpoint) return;
  missingRegistrationHealed.add(account.publicKey);

  try {
    await finalizeDirectGuardianSwitch(account.publicKey, endpoint, zustandProvider);
    clearGuardianServiceFor(account.publicKey);
    console.warn(
      `[Guardian Sync] registered ${account.publicKey} on ${endpoint} after the operator reported no record of it`
    );
  } catch (e) {
    console.warn(
      `[Guardian Sync] could not register ${account.publicKey} on ${endpoint} (not retried this session):`,
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
 * repeated), bounded retry (give up if re-registering the on-chain set doesn't
 * clear the 401, i.e. the local signer genuinely isn't on-chain), and a cooldown
 * — is made by the caller via `decideColdReRegisterSelfHeal`; this function only
 * performs the attempt.
 *
 * On guardian v0.16.0 the common post-rotation case never reaches here: the
 * guardian canonicalizes every co-signed delta and RE-DERIVES the allowlist from
 * the on-chain signer set on its own, so a rotation self-syncs the allowlist
 * without any `/configure`. This is therefore defensive — for a genuinely
 * never-registered / never-canonicalized signer set. Idempotent (registers the
 * on-chain state), so a spurious run is harmless.
 */
async function attemptColdReRegisterSelfHeal(account: WalletAccount): Promise<void> {
  // Legacy single-key record (pre-migration) has nothing to cold-sign with.
  if (!account.coldPublicKey) return;

  try {
    // getAccount needs no syncState here: buildColdMultisigService only reads the
    // COLD commitment (stable across the rotation), and
    // reRegisterCurrentStateOnGuardian re-syncs on its own for the state it
    // pushes. The two lock uses are sequential (this getAccount releases before
    // the cold service acquires), never nested — no reentrancy deadlock.
    const staleAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(account.publicKey));
    if (!staleAccount) return;

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
    const coldService = await MultisigService.buildColdMultisigService(staleAccount, account, zustandProvider.signWord);
    await coldService.adoptGuardianStateOnce().catch(e => {
      console.warn(`[Guardian Sync] could not read the guardian's state before self-healing ${account.publicKey}:`, e);
    });

    const sdkAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(account.publicKey));
    if (!sdkAccount) return;

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
    const onChainHot = await getSignerDetailsFromAccount(sdkAccount, false).catch(() => undefined);
    if (account.hotPublicKey && onChainHot) {
      const localHot = await commitmentFromPublicKeyHex(account.hotPublicKey).catch(() => undefined);
      if (localHot && !sameCommitment(localHot, onChainHot.commitment)) {
        console.warn(
          `[Guardian Sync] not self-healing ${account.publicKey}: this device's hot key is no longer the ` +
            `account's on-chain signer (it was rotated to another device). Re-registering would revoke ` +
            `the device that now owns the account.`
        );
        return;
      }
    }

    await coldService.reRegisterCurrentStateOnGuardian();
    console.warn(`[Guardian Sync] cold re-register self-heal succeeded for ${account.publicKey}`);
  } catch (e) {
    // Guardian still unreachable / rejecting cold — a later tick may retry per
    // the bounded schedule (see decideColdReRegisterSelfHeal).
    console.warn(`[Guardian Sync] cold re-register self-heal failed for ${account.publicKey}:`, e);
  }
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

export function syncGuardianAccounts(): Promise<void> {
  syncInFlight ??= runGuardianAccountsSync().finally(() => {
    syncInFlight = undefined;
  });
  return syncInFlight;
}

async function runGuardianAccountsSync(): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const guardianAccounts = accounts.filter(acc => acc.type === WalletType.Guardian && Boolean(acc.hotPublicKey));

  if (guardianAccounts.length === 0) return;

  for (const account of guardianAccounts) {
    // Serve the guardian's own cooldown before anything else: a rate-limited
    // account has nothing to gain from another request, and every one we skip is
    // budget the transaction path can use instead.
    const pausedUntil = rateLimitedUntil.get(account.publicKey);
    if (pausedUntil !== undefined) {
      if (Date.now() < pausedUntil) continue;
      rateLimitedUntil.delete(account.publicKey);
    }

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
    // Best-effort: a drift-check failure must never break the sync loop.
    await useWalletStore
      .getState()
      .checkGuardianDrift(account.publicKey)
      .catch(() => {});

    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider);
      await service.sync();

      // Sync succeeded → the account is authorized; clear any accumulated
      // self-heal state so a future divergence starts its persistence count
      // fresh, and stand down the guardian-unreachable prompt.
      consecutiveAuthFailures.delete(account.publicKey);
      selfHealState.delete(account.publicKey);
      missingRegistrationHealed.delete(account.publicKey);
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
        // A 401 is the server answering — the guardian is up.
        clearGuardianServerFailures(account.publicKey);
        clearGuardianServiceFor(account.publicKey);
        const fails = (consecutiveAuthFailures.get(account.publicKey) ?? 0) + 1;
        consecutiveAuthFailures.set(account.publicKey, fails);
        const now = Date.now();
        if (decideColdReRegisterSelfHeal(now, fails, selfHealState.get(account.publicKey))) {
          const prev = selfHealState.get(account.publicKey);
          selfHealState.set(account.publicKey, { attempts: (prev?.attempts ?? 0) + 1, lastAttemptAt: now });
          await attemptColdReRegisterSelfHeal(account);
        }
      } else if (isGuardianRateLimited(error)) {
        // Back off for as long as the guardian asked, and say so once rather than
        // every 3s. A 429 is not an auth problem, so the failure count resets —
        // and it proves the server is up, so the outage flag clears too.
        consecutiveAuthFailures.delete(account.publicKey);
        clearGuardianServerFailures(account.publicKey);
        const askedMs = (guardianRetryAfterSec(error) ?? 0) * 1000;
        const cooldown = Math.min(
          Math.max(askedMs, SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS),
          SYNC_RATE_LIMIT_MAX_COOLDOWN_MS
        );
        rateLimitedUntil.set(account.publicKey, Date.now() + cooldown);
        console.warn(
          `[Guardian Sync] rate limited (429) for ${account.publicKey}; pausing sync for ${Math.round(cooldown / 1000)}s`
        );
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
        consecutiveAuthFailures.delete(account.publicKey);
        clearGuardianServerFailures(account.publicKey);
        await attemptMissingRegistrationSelfHeal(account);
      } else {
        // Non-auth error — don't accumulate auth-failure count.
        consecutiveAuthFailures.delete(account.publicKey);
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
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
