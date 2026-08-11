import { isGuardianAuthRejection, MultisigService } from 'lib/miden/guardian';
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
    const sdkAccount = await withWasmClientLock(async () => midenClientProxy.getAccount(account.publicKey));
    if (!sdkAccount) return;
    const coldService = await MultisigService.buildColdMultisigService(sdkAccount, account, zustandProvider.signWord);
    await coldService.reRegisterCurrentStateOnGuardian();
    console.warn(`[Guardian Sync] cold re-register self-heal succeeded for ${account.publicKey}`);
  } catch (e) {
    // Guardian still unreachable / rejecting cold — a later tick may retry per
    // the bounded schedule (see decideColdReRegisterSelfHeal).
    console.warn(`[Guardian Sync] cold re-register self-heal failed for ${account.publicKey}:`, e);
  }
}

export async function syncGuardianAccounts(): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const guardianAccounts = accounts.filter(acc => acc.type === WalletType.Guardian && Boolean(acc.hotPublicKey));

  if (guardianAccounts.length === 0) return;

  for (const account of guardianAccounts) {
    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider);
      await service.sync();

      // Sync succeeded → the account is authorized; clear any accumulated
      // self-heal state so a future divergence starts its persistence count
      // fresh.
      consecutiveAuthFailures.delete(account.publicKey);
      selfHealState.delete(account.publicKey);

      // Best-effort: a drift-check failure must never break the sync loop.
      await useWalletStore
        .getState()
        .checkGuardianDrift(account.publicKey)
        .catch(() => {});

      // Self-heal the update_guardian threshold-2 hardening: if a migrated
      // account's original hardening tx was dropped, it would otherwise sit at
      // threshold-1 indefinitely. Idempotent + best-effort; once per session.
      if (!hardeningChecked.has(account.publicKey)) {
        hardeningChecked.add(account.publicKey);
        const { ensureGuardianProcedureThresholds } = await import('lib/miden/transaction');
        await ensureGuardianProcedureThresholds(account.publicKey, undefined, zustandProvider);
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
        clearGuardianServiceFor(account.publicKey);
        const fails = (consecutiveAuthFailures.get(account.publicKey) ?? 0) + 1;
        consecutiveAuthFailures.set(account.publicKey, fails);
        const now = Date.now();
        if (decideColdReRegisterSelfHeal(now, fails, selfHealState.get(account.publicKey))) {
          const prev = selfHealState.get(account.publicKey);
          selfHealState.set(account.publicKey, { attempts: (prev?.attempts ?? 0) + 1, lastAttemptAt: now });
          await attemptColdReRegisterSelfHeal(account);
        }
      } else {
        // Non-auth error (e.g. network) — don't accumulate auth-failure count.
        consecutiveAuthFailures.delete(account.publicKey);
      }
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
