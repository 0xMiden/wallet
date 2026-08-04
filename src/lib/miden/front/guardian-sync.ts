import { isGuardianAuthRejection, MultisigService } from 'lib/miden/guardian';
import type { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { clearGuardianServiceFor, getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

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

// Cold re-register self-heal: at most one attempt per COOLDOWN per account, so a
// persistently-failing /configure can't storm the guardian on every ~3s tick.
const SELF_HEAL_COOLDOWN_MS = 60_000;
const lastReRegisterSelfHealAt = new Map<string, number>();

/**
 * A hot-bound guardian sync just auth-rejected (401). For a post-rotation
 * account that means the guardian's request-auth allowlist
 * (`auth.cosigner_commitments`) is STALE — still the PRE-rotation hot signer —
 * because the post-rotation cold re-register that
 * `completeReplaceHotKeyTransaction` runs is best-effort and silently swallowed
 * on failure (`transaction/complete.ts:284-289`), e.g. a guardian outage across
 * all its retries. The new hot key is then unauthorized forever: every hot sync
 * 401s, and `runSync`'s own re-register (`guardian/index.ts:382`) is itself
 * hot-bound so it 401s too — a permanent loop.
 *
 * Break it by re-registering COLD-signed. `update_signers` is threshold-1 and
 * the guardian request-auth is cold-satisfiable: cold is a PERMANENT allowlist
 * member (present in both the fresh `[new-hot, cold]` and the stale
 * `[old-hot, cold]` sets), so a cold-signed `/configure` authenticates against
 * the stale allowlist and rewrites it to the current on-chain signer set,
 * re-authorizing the new hot key. This reuses the exact machinery the completion
 * path uses (`MultisigService.buildColdMultisigService` →
 * `reRegisterCurrentStateOnGuardian`) and inherits its one assumption — that the
 * guardian server authorizes a cold-signed re-config against a stale allowlist.
 *
 * Fires ONLY on a genuine 401 (`isGuardianAuthRejection`), never on a network
 * error, so it runs precisely when the guardian is UP and rejecting hot (the
 * stale-allowlist case) — exactly when a cold `/configure` will land. Idempotent
 * (re-registers the current on-chain state), so a spurious fire is harmless.
 */
async function attemptColdReRegisterSelfHeal(account: WalletAccount): Promise<void> {
  // Legacy single-key record (pre-migration) has nothing to cold-sign with.
  if (!account.coldPublicKey) return;

  const now = Date.now();
  if (now - (lastReRegisterSelfHealAt.get(account.publicKey) ?? 0) < SELF_HEAL_COOLDOWN_MS) return;
  // Stamp BEFORE attempting: a concurrent ~3s tick (and a persistently-failing
  // /configure) must not re-enter until the cooldown elapses.
  lastReRegisterSelfHealAt.set(account.publicKey, now);

  try {
    // getAccount needs no syncState here: buildColdMultisigService only reads the
    // COLD commitment (stable across the rotation), and
    // reRegisterCurrentStateOnGuardian re-syncs on its own for the state it
    // pushes. The two lock uses are sequential (this getAccount releases before
    // the cold service acquires), never nested — no reentrancy deadlock.
    const sdkAccount = await withWasmClientLock(async () => (await getMidenClient()).getAccount(account.publicKey));
    if (!sdkAccount) return;
    const coldService = await MultisigService.buildColdMultisigService(sdkAccount, account, zustandProvider.signWord);
    await coldService.reRegisterCurrentStateOnGuardian();
    console.warn(`[Guardian Sync] cold re-register self-heal succeeded for ${account.publicKey}`);
  } catch (e) {
    // Guardian still unreachable / rejecting cold — retry after the cooldown.
    console.warn(
      `[Guardian Sync] cold re-register self-heal failed (will retry after cooldown) for ${account.publicKey}:`,
      e
    );
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
      // next tick rebuilds against freshly-synced on-chain state. But eviction
      // ALONE is a dead end when the allowlist is genuinely STALE (the
      // post-rotation cold re-register failed, e.g. a guardian outage): the
      // rebuilt service is still hot-bound and 401s again forever. So also
      // attempt a cold-signed re-register, which is the ONLY thing that can
      // re-authorize the new hot key against a stale allowlist (see
      // attemptColdReRegisterSelfHeal).
      if (isGuardianAuthRejection(error)) {
        clearGuardianServiceFor(account.publicKey);
        await attemptColdReRegisterSelfHeal(account);
      }
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
