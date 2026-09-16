import { MultisigService } from 'lib/miden/guardian';
import { clearGuardianAccountLocks } from 'lib/miden/guardian/serialize';
import { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { midenClientProxy } from '../back/miden-client-proxy';
import { getSignerDetailsFromAccount, resolveGuardianEndpoint } from '../guardian/account';
import { sameWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS, wasmClientGeneration } from '../sdk/wasm-client-poison';

// Cache MultisigService instances to avoid re-initialization on every sync cycle.
// `hotPublicKey` is recorded alongside so rotations are detected on next access:
// the cached service is bound to a specific WalletSigner pubkey, and after a
// replace-hot-key tx the WalletAccount.hotPublicKey changes — without the
// drift check, the popup sync keeps signing with the rotated-out key.
//
// `generation` is the WASM client generation the service was built on (issue
// #775). A cached `MultisigService` is bound to the SDK `Account` handle and web
// client it was built from, so once lock recovery replaces that client the
// service is a corpse — and the guardian sync would go on using it every ~3s
// until a full reload, leaving every guardian account permanently broken after a
// recovery that was otherwise transparent. Recorded rather than watched: the
// staleness only matters at the next access, and reading the counter there keeps
// this module free of an import-time dependency on the SDK.
type CacheEntry = { service: MultisigService; hotPublicKey: string; generation: number };
const guardianServiceCache = new Map<string, CacheEntry>();

// In-flight MultisigService.init promises, keyed by accountPublicKey. The
// guardian sync runs every 3s and does not await previous ticks; without this,
// each tick can start a fresh init before the resolved service reaches the cache.
// Tagged with the generation it started on, so a caller arriving after a recovery
// is not handed an init that is building on the client that just died.
type InflightEntry = { promise: Promise<MultisigService>; generation: number };
const guardianServiceInflight = new Map<string, InflightEntry>();

/**
 * Callbacks for resolving account data.
 * Allows guardian-manager to work in both frontend (Zustand) and service worker (Vault) contexts.
 *
 * NOTE: This module must stay SW-safe — don't import `lib/store` here.
 * The Zustand-backed default provider lives in `./guardian-sync.ts` (frontend-only).
 */
export interface GuardianAccountProvider {
  getAccounts: () => Promise<WalletAccount[]>;
  getPublicKeyForCommitment: (commitment: string) => Promise<string>;
  signWord: (publicKey: string, wordHex: string) => Promise<string>;
  // Optional SW-only callbacks used by the proactive replace-hot-key flow.
  // Frontend providers (zustandProvider) leave these undefined; the rotation
  // path runs only inside the SW-side transaction processor where the
  // vault-backed provider implements them.
  persistNewHotKey?: (newHotPubKey: string, newHotCiphertext: string) => Promise<void>;
  swapHotKey?: (accountPublicKey: string, newHotPubKey: string) => Promise<void>;
  // Persist a per-account guardian endpoint after a switch-guardian lands.
  // SW-only (vault-backed); the frontend zustand provider leaves it undefined
  // because guardian-switch completion runs exclusively in the backend processor.
  setGuardianEndpoint?: (accountPublicKey: string, guardianEndpoint: string) => Promise<void>;
}

/**
 * Create a MultisigService for the given Guardian account.
 * Returns a cached instance if available.
 */
export async function getOrCreateMultisigService(
  accountPublicKey: string,
  provider: GuardianAccountProvider,
  /**
   * Bound the account read at the sync ceiling instead of the five-minute backstop.
   *
   * Passed by the ONE caller on a cadence — the idle loop's guardian sync — and by nobody
   * else, which is the whole point of making it a parameter rather than a constant. On the
   * #777 path this hold is not the warm cache read it looks like: every watchdog eviction
   * bumps the client generation, which invalidates this cache, so the very next lap takes
   * this hold with an empty client slot and sends a fresh genesis fetch to the node that
   * just parked. Left on the backstop that is five minutes of frozen wallet per lap, and
   * four laps to light the account's fuse. The ten transaction-pipeline callers keep the
   * backstop: a user is waiting on those, and `reconcileStructuralApplyFailure` in
   * particular runs after a structural change is already on chain, where giving up three
   * minutes sooner risks stranding the account it exists to rescue.
   */
  boundAtSyncCeiling = false
): Promise<MultisigService> {
  // NOTE: no endpoint-only fast-path here. The cache hit is served by the inner
  // check below (after we resolve the account's current hotPublicKey), which
  // compares BOTH the guardian endpoint AND the bound hot pubkey. An outer
  // endpoint-only check returned the stale service after a replace_hot_key
  // rotation (which doesn't touch the endpoint), so the popup kept signing with
  // the rotated-out hot key — `clearGuardianServiceFor` runs in the SW realm and
  // never evicts the popup's Map. getAccounts() is an in-memory store read, so
  // routing cache hits through init is cheap.
  // Coalesce concurrent inits: the guardian sync runs every 3s and does not
  // await previous ticks, so without this an in-flight init can start again
  // before its resolved service reaches the cache.
  const startedAtGeneration = wasmClientGeneration();
  const inflight = guardianServiceInflight.get(accountPublicKey);
  if (inflight) {
    // Only coalesce onto an init that is building on the CURRENT client. One
    // started before a recovery will resolve a service bound to the dead client,
    // and handing it to a caller that arrived afterwards would spread the corpse
    // instead of containing it (#775).
    if (inflight.generation === startedAtGeneration) {
      return inflight.promise;
    }
    guardianServiceInflight.delete(accountPublicKey);
  }

  const initPromise = (async () => {
    // Verify this is a Guardian account
    const accounts = await provider.getAccounts();
    // Match tolerant of id form: dApp-initiated txs arrive with the bare bech32
    // address while WalletAccount.publicKey is a composite `<address>_<suffix>`.
    const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, accountPublicKey));
    if (!account || account.type !== WalletType.Guardian) {
      throw new Error('Account is not a Guardian account');
    }
    // Hot pubkey lives on the WalletAccount record (set at create time). A
    // Guardian account without it is either a legacy single-Falcon-key record
    // (pre-migration) or an in-flight write that crashed mid-create — both are
    // unsigned states that should fail loudly rather than silently fall back.
    if (!account.hotPublicKey) {
      throw new Error(`Guardian account ${accountPublicKey} is missing hotPublicKey — re-create the wallet`);
    }
    const hotPublicKey = account.hotPublicKey;
    // Per-account guardian endpoint (falls back to the legacy global key for
    // records created before the field existed). Resolved once and reused for
    // both the cache drift-check and the init binding below.
    const currentEndpoint = await resolveGuardianEndpoint(account);

    // Return cached instance if its endpoint AND bound hot pubkey still match.
    // Two separate drift sources:
    //   - guardian endpoint: switch_guardian rotates the URL; clearGuardianServiceFor
    //     in the SW realm doesn't reach the popup's Map, so re-check here.
    //   - hot pubkey: replace_hot_key rotates account.hotPublicKey; the cached
    //     service is still bound to the previous WalletSigner.publicKey.
    //   - WASM client generation: lock recovery replaced the client the cached
    //     service is bound to, so every call it makes now throws (#775).
    const cached = guardianServiceCache.get(accountPublicKey);
    if (cached) {
      if (
        cached.service.guardianEndpoint === currentEndpoint &&
        cached.hotPublicKey === hotPublicKey &&
        cached.generation === wasmClientGeneration()
      ) {
        return cached.service;
      }
      guardianServiceCache.delete(accountPublicKey);
    }

    // Get the Account object from the Miden client. Always labelled; bounded only for the
    // caller that runs on a cadence — see `boundAtSyncCeiling` above (#777).
    const { sdkAccount } = await withWasmClientLock(
      async () => {
        // Use the matched account's stored publicKey (the form the in-wallet path
        // uses) rather than the possibly-bare dApp-supplied id.
        const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
        return { sdkAccount };
      },
      boundAtSyncCeiling
        ? { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-service-build' }
        : { label: 'guardian-service-build' }
    );

    if (!sdkAccount) {
      throw new Error('Account not found in local storage');
    }

    // Hot signer commitment lives at signer index 0 (order is [hot, cold]).
    const { commitment } = await getSignerDetailsFromAccount(sdkAccount);
    // Bind the service to the hot signer — the popup signs with the hot key.
    console.log('creating guardian service', sdkAccount.id().toString());
    const service = await MultisigService.init(
      sdkAccount,
      `0x${hotPublicKey}`,
      `0x${commitment}`,
      provider.signWord,
      currentEndpoint
    );

    // Cache for future use, tagged with the hot pubkey it was bound to so the
    // next access can detect rotation and force a re-init, and with the client
    // generation it was built on so a recovery in the meantime forces one too.
    // The tag is the generation observed at ENTRY, which is the one this
    // service's client handle came from — so a recovery that landed mid-init
    // leaves the entry already stale and the next access rebuilds. This caller
    // still gets the service and fails on its next WASM call, exactly as every
    // other in-flight user of the dead client does.
    guardianServiceCache.set(accountPublicKey, { service, hotPublicKey, generation: startedAtGeneration });

    return service;
  })();

  guardianServiceInflight.set(accountPublicKey, { promise: initPromise, generation: startedAtGeneration });
  try {
    return await initPromise;
  } finally {
    // Evict on settle (success or failure) so a failed init can be retried on
    // the next sync tick while successful inits use guardianServiceCache. Only
    // OUR entry: a generation change can have displaced it with a newer init,
    // and deleting that one would let the next tick start a third.
    if (guardianServiceInflight.get(accountPublicKey)?.promise === initPromise) {
      guardianServiceInflight.delete(accountPublicKey);
    }
  }
}

/**
 * Check if an account is a Guardian account.
 */
export async function isGuardianAccount(accountPublicKey: string, provider: GuardianAccountProvider): Promise<boolean> {
  const accounts = await provider.getAccounts();
  // Tolerant match — see sameWalletAccountId. A raw `===` misses when a dApp
  // supplies the bare bech32 address, misrouting a Guardian account non-guardian.
  const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, accountPublicKey));
  return account?.type === WalletType.Guardian;
}

/**
 * Clear the Guardian service cache. Call on logout/lock.
 */
export function clearGuardianCache(): void {
  guardianServiceCache.clear();
  guardianServiceInflight.clear();
  clearGuardianAccountLocks();
}

/**
 * Drop a single account's cached MultisigService so the next access
 * reinitializes it — used after a guardian switch where the cached
 * instance still points at the old endpoint.
 */
export function clearGuardianServiceFor(accountPublicKey: string): void {
  guardianServiceCache.delete(accountPublicKey);
  guardianServiceInflight.delete(accountPublicKey);
}
