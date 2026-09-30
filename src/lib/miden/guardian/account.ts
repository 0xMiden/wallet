import { Account, AuthSecretKey, MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { AccountInspector, EcdsaSigner, MultisigClient } from '@openzeppelin/miden-multisig-client';
import { Buffer } from 'buffer';

import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { getEffectiveDefaultGuardianEndpoint, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isExtension } from 'lib/platform';
import * as secureHotKey from 'lib/secure-hot-key';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { sameGuardianEndpoint } from 'lib/settings/helpers';
import type { GuardianProvider } from 'lib/shared/types';

import { withTimeout } from './discover';
import { isGuardianKeyCommitment } from './key-commitment';
import { withGuardianProbe } from './native-http';
import { NEW_GUARDIAN_PUBKEY_TIMEOUT_MS, withGuardianRateLimitRetry } from './serialize';
import { fetchFromStorage } from '../front/storage';
import type { AssertLive } from '../sdk/miden-client-interface';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

/**
 * Resolve the guardian operator endpoint for a Guardian account.
 *
 * Prefers the per-account `guardianEndpoint` (set at create/recovery time and
 * on switch-guardian) so accounts on different operators don't collide. Falls
 * back to the legacy global `GUARDIAN_URL_STORAGE_KEY`, then to the effective
 * network's default guardian.
 *
 * The global-key fallback is retained BY DESIGN as a frozen, read-only fallback
 * (#408 stage 3): nothing writes the key. The unlock-time backfill stamps a
 * per-account endpoint on every legacy account it can resolve on-chain, but a
 * legacy account on a custom/self-hosted/rotated guardian that the backfill
 * cannot identify has this key as its only pointer, so a wallet that is only
 * ever unlocked keeps it. It is dropped once a wallet setup succeeds
 * (`dropLegacyGuardianUrl`) and by a full reset; see `GUARDIAN_URL_STORAGE_KEY`.
 * Do NOT delete this read; removing the key from a wallet that is only ever
 * unlocked needs a "re-enter your guardian URL" user flow (out of scope).
 */
export async function resolveGuardianEndpoint(account: { guardianEndpoint?: string }): Promise<string> {
  return (await resolveChosenGuardianEndpoint(account)) ?? getEffectiveDefaultGuardianEndpoint();
}

/**
 * The guardian pointer this account actually CHOSE — the per-account field, then
 * the legacy global key — with the network default deliberately excluded, so an
 * account with no pointer at all answers `undefined` rather than a guess.
 *
 * Split out because the two halves are not interchangeable for every caller, and
 * conflating them has now been a defect in both directions. Callers that merely
 * need somewhere to talk to want the default (`resolveGuardianEndpoint`). Callers
 * about to make an ACCUSATION or a WRITE must not have it: the drift reconciler
 * treats a denial from the default as no evidence, and the missing-registration
 * self-heal POSTs this device's serialized private account state as an operator's
 * authoritative `initialState` — which must never go to an endpoint the wallet
 * guessed rather than one the account named.
 *
 * Reading the raw field alone is the opposite error, and the one this exists to
 * stop repeating: a pre-per-account-endpoint account on a custom operator has the
 * global key as its ONLY pointer, because the unlock backfill leaves that
 * account's field empty rather than stamping a guess.
 *
 * A failed storage read PROPAGATES, deliberately. Swallowing it here reads as
 * tidiness and is a lie in two directions at once: `undefined` would then mean
 * both "this account named no operator" and "we could not find out", and the two
 * demand opposite handling — the first is a verdict a caller may act on, the
 * second is a caller that must do nothing this window. It would also silently
 * change `resolveGuardianEndpoint` for every one of its other callers, turning a
 * read failure into the network default: a guess, returned as though it were the
 * account's own pointer. Callers that want best-effort must say so at their own
 * call site, where they can choose the right degradation.
 */
export async function resolveChosenGuardianEndpoint(account: {
  guardianEndpoint?: string;
}): Promise<string | undefined> {
  if (account.guardianEndpoint) return account.guardianEndpoint;
  return (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || undefined;
}

/**
 * Adopt a guardian-served account snapshot locally, refusing any write that
 * would move the account's state BACKWARDS.
 *
 * Guardian snapshots are not ordered, and one recovery adopts the same account
 * more than once: `recoverGuardianAccountsBySeed` matches an account at more
 * than one HD index and inserted each match with `overwrite: true`, so whichever
 * snapshot arrived last won. That is fine while the snapshots agree (both at the
 * account's current nonce, the common case) and silently corrupting when they
 * don't: a creation-time snapshot (nonce 0) landing last leaves the account
 * locally UNCOMMITTED, so the next hot-key rotation is built as an account
 * CREATION and the node rejects it —
 *
 *   initial account commitment 0x0000…0000 does not match the current
 *   commitment 0x41978d… for account 0x2cb3bb1e…
 *
 * — which is the intermittent `guardian-recovery` failure seen on main. Ordering
 * decides the outcome, hence a flake rather than a hard break.
 *
 * Nonce is the ordering key because it increments once per committed
 * state-changing transaction, so a lower nonce is by definition a staler view of
 * the same account. Equal nonces still overwrite: same committed state, and the
 * incoming snapshot may carry detail the stored record lacks.
 *
 * Monotonic account state is already an invariant one layer down — the client's
 * own store rejects the mirror image of this write with "replace_account_header:
 * new nonce 1 is less than old nonce 2" (observed in the same failing run, on a
 * second account). This upholds it before the write instead of discovering it
 * afterwards, and it belongs on the wallet side because the guardian is an
 * untrusted remote: `importAccountFromGuardian` already refuses a snapshot whose
 * account ID doesn't match, for the same reason.
 *
 * Callers MUST already hold the WASM client lock — this issues client calls and
 * does not acquire it, so acquiring here would deadlock the existing
 * `withWasmClientLock` scopes both call sites run inside.
 */
export async function insertGuardianAccountMonotonically(client: MidenClient, account: Account): Promise<void> {
  const accountId = account.id();
  const incomingNonce = account.nonce().asInt();
  const stored = await client.accounts.get(accountId);

  if (stored && incomingNonce < stored.nonce().asInt()) {
    console.warn(
      `[guardian] ignoring stale account snapshot for ${accountId.toString()}: ` +
        `guardian served nonce ${incomingNonce}, local state is at nonce ${stored.nonce().asInt()}`
    );
    return;
  }

  await client.accounts.insert({ account, overwrite: true });
}

/**
 * Material the wallet must persist after a Guardian account is created.
 * Hot is held outside the SDK keystore (secure-hot-key facade); cold lives
 * inside the SDK keystore *and* is mirrored to a separate vault entry so
 * role-aware signWord (Phase 3) can route by storage entity.
 */
export interface CreatedGuardianKeys {
  hotPublicKey: string; // serialize().slice(1) hex
  coldPublicKey: string; // serialize().slice(1) hex
  hotCiphertext: string; // opaque blob from the secure-hot-key facade
  coldSecretKeyHex: string; // serialized AuthSecretKey hex (for cold-mirror storage)
}

export interface CreatedGuardianAccount {
  account: Account;
  keys: CreatedGuardianKeys;
  // The guardian operator endpoint this account was registered with — persisted
  // onto the WalletAccount so runtime reads resolve per-account, not globally.
  guardianEndpoint: string;
}

/**
 * Both readers below go through `AccountInspector` rather than reading storage
 * slots by name. The wallet used to re-declare the slot names locally, which
 * broke silently when the component moved namespace in multisig-client 0.17
 * (`openzeppelin::multisig::signer_public_keys` →
 * `miden::standards::auth::multisig::approver_public_keys`): every read
 * returned nothing, so a freshly-created Guardian account looked like it had no
 * signers and every proposal failed with "No signer commitment found in account
 * storage". The names are deliberately not exported by the package for exactly
 * this reason — the inspector is the supported, layout-insulated accessor, and
 * it reads by signer index, so it also keeps the by-key (not by-SMT-order)
 * semantics the previous code was careful to preserve.
 */
const stripHexPrefix = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

/** An absent map entry reads back as the empty word (all zeros) in some SDK builds. */
const isEmptyWordHex = (unprefixed: string): boolean => /^0*$/.test(unprefixed);

/**
 * Read a signer's commitment from a Guardian account.
 *
 * 3-key accounts store `[hot@0, cold@1]`; legacy single-key Guardian accounts
 * (feature #153) keep the cold/HD key alone at index 0. So for the cold lookup
 * we read index 1 and fall back to index 0 — otherwise activating a migrated
 * legacy account would read a non-existent index 1 and brick it.
 */
export async function getSignerDetailsFromAccount(account: Account, getCold = false): Promise<{ commitment: string }> {
  const noSigner = new Error('No signer commitment found in account storage');

  // The inspector throws when the account isn't a guarded multisig or any
  // signer entry is unreadable; both mean the same thing to callers here.
  let commitments: string[];
  try {
    commitments = AccountInspector.getSignerPublicKeyCommitments(account);
  } catch {
    throw noSigner;
  }

  const raw = getCold ? (commitments[1] ?? commitments[0]) : commitments[0];
  if (raw === undefined) throw noSigner;

  const commitment = stripHexPrefix(raw);
  if (isEmptyWordHex(commitment)) throw noSigner;

  return { commitment };
}

/**
 * Read the on-chain guardian operator key commitment — a SEPARATE storage slot
 * from the multisig signer keys read by `getSignerDetailsFromAccount`.
 * Returns unprefixed hex, or undefined if absent / the empty (all-zero) word.
 *
 * The type check is not redundant with the `catch`. The declared return type is
 * the library's promise, not a guarantee; a slot read that yields no string
 * returns rather than throwing, and `stripHexPrefix` would then call `.startsWith`
 * on it and throw a bare TypeError PAST the catch — out of a function whose whole
 * contract is `string | undefined`. Callers act on that undefined (refusing a
 * registration, skipping a drift verdict), so it has to be produced rather than
 * escaped.
 */
export function getGuardianCommitmentFromAccount(account: Account): string | undefined {
  let raw: unknown;
  try {
    raw = AccountInspector.getGuardianPublicKeyCommitment(account);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const unprefixed = stripHexPrefix(raw);
  return isEmptyWordHex(unprefixed) ? undefined : unprefixed;
}

/**
 * Validate a guardian key commitment that came off the WIRE (`GET /pubkey`),
 * returning it 0x-prefixed and lowercased.
 *
 * `GuardianHttpClient.getPubkey` returns `(await response.json()).commitment`
 * with no runtime check, so this value is whatever the endpoint chose to send —
 * and the switch-guardian paths feed it to
 * `buildUpdateGuardianTransactionRequest`, which interpolates it into MASM
 * SOURCE (`push.${keyLiteral}` in the SDK's `updateGuardian.ts`) after only
 * `normalizeHexWord`, a lowercase + `padStart(64, '0')` that validates neither
 * the charset nor the length. A commitment longer than 64 characters therefore
 * passes through untouched, newlines included, and the wallet compiles and
 * signs whatever instructions followed it — with BOTH the hot and cold keys,
 * against an account whose script the rotation UI never shows. A non-string
 * (`null`, a number, an object) instead reaches `.startsWith` and throws a bare
 * TypeError from inside the SDK.
 *
 * So this is the trust boundary for the one guardian response that becomes
 * code: exactly one word of hex, nothing else. Every legitimate operator serves
 * a 32-byte word, and the mismatch case is already covered downstream by the
 * on-chain commitment comparison.
 */
export function assertGuardianKeyCommitment(commitment: unknown, endpoint: string): string {
  if (!isGuardianKeyCommitment(commitment)) {
    throw new Error(
      `Guardian endpoint ${endpoint} returned a malformed key commitment; expected a 32-byte hex word (64 hex digits)`
    );
  }
  return `0x${stripHexPrefix(commitment).toLowerCase()}`;
}

const PROVIDER_ID_MAP: Record<string, GuardianProvider> = {
  'open-zeppelin': 'open-zeppelin',
  gateway: 'gateway',
  'lambda-class': 'lambda-class'
};

/**
 * Reverse-map an endpoint URL to its built-in GUARDIAN_OPTIONS provider id;
 * 'custom' if the endpoint doesn't match any known provider; null if the
 * endpoint itself is null (account has no guardian).
 */
export function guardianProviderFromEndpoint(endpoint: string | null): GuardianProvider | null {
  if (!endpoint) return null;
  for (const option of GUARDIAN_OPTIONS) {
    for (const url of option.endpoint.values()) {
      if (sameGuardianEndpoint(url, endpoint)) return PROVIDER_ID_MAP[option.id] ?? 'custom';
    }
  }
  return 'custom';
}

/**
 * How long a Guardian account creation may spend waiting out guardian 429s,
 * across both of its guardian calls. The creation runs inside the WASM client
 * lock, so its waits are held against `WASM_LOCK_WATCHDOG_MS` and block every
 * other WASM operation in the realm; 90 s covers one full per-minute cooldown
 * and keeps the onboarding spinner bounded. Moving the waits off the lock is
 * wallet#1207.
 */
export const GUARDIAN_CREATE_RATE_LIMIT_BUDGET_MS = 90_000;

const GUARDIAN_WAIT_KEEPALIVE_ALARM = 'miden-guardian-wait-keepalive';

/**
 * Sleep for a guardian 429 wait. Chrome stops an idle MV3 service worker after
 * ~30 s and a wait can last up to GUARDIAN_CREATE_RATE_LIMIT_BUDGET_MS, so on the
 * extension a repeating alarm keeps the worker alive for the wait, as the
 * transaction processor's does for its loop, and is cleared when the wait ends.
 * The polyfill is loaded only there: it throws at load outside an extension, and
 * this module is in the mobile bundle.
 */
async function sleepKeepingWorkerAlive(ms: number): Promise<void> {
  const browser = isExtension() ? await import('webextension-polyfill').then(m => m.default) : undefined;
  await browser?.alarms.create(GUARDIAN_WAIT_KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  try {
    await new Promise(resolve => setTimeout(resolve, ms));
  } finally {
    await browser?.alarms.clear(GUARDIAN_WAIT_KEEPALIVE_ALARM);
  }
}

/**
 * Create a 3-key Guardian account: a random hot ECDSA key (held outside the
 * WASM keystore, behind the secure-hot-key facade), an HD-derived cold ECDSA
 * key (held inside the keystore, used for rotation/recovery), and the external
 * guardian co-signer. Default threshold 1 — hot OR cold + guardian satisfies
 * routine operations; cold-only routing for rotation procedures is enforced
 * client-side (see Phase 0 in the migration plan).
 *
 * @param webClient - The Miden WebClient instance.
 * @param coldSeed - HD-derived seed for the cold key. Random if absent (only
 *   appropriate for tests / non-recoverable flows).
 * @param skipRegistration - Skip guardian registration (used by the import path).
 * @param guardianEndpointOverride - Force a specific guardian URL for pubkey
 *   derivation. Account ID is a content hash that includes the guardian pubkey
 *   baked into storage, so the import flow passes the effective default
 *   guardian endpoint to reproduce the ID the account originally had.
 * @param assertLive - The caller's WASM lock hold re-check. The creation runs
 *   inside that hold and its 429 waits park there; an evicted flow is abandoned,
 *   not cancelled, so every WASM call and guardian write after a parking await
 *   runs it first, and the poison error it throws leaves here unwrapped.
 */
export async function createGuardianAccount(
  webClient: MidenClient,
  coldSeed?: Uint8Array,
  skipRegistration: boolean = false,
  guardianEndpointOverride?: string,
  assertLive: AssertLive = () => {}
): Promise<CreatedGuardianAccount> {
  if (!coldSeed) {
    coldSeed = crypto.getRandomValues(new Uint8Array(32));
  }

  try {
    // Cold key — HD-derived, lives in SDK keystore, used for cold-routed flows
    // (rotation, recovery). EcdsaSigner gets the cold AuthSecretKey directly so
    // the create-time deploy proposal is signed by cold; the on-chain account
    // therefore binds to the cold commitment via the deploy signature in
    // addition to the storage-slot binding.
    const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
    const coldPublicKeyObj = coldSk.publicKey();
    const coldCommitmentHex = coldPublicKeyObj.toCommitment().toHex();
    const coldPublicKey = Buffer.from(coldPublicKeyObj.serialize().slice(1)).toString('hex');
    const coldSecretKeyHex = Buffer.from(coldSk.serialize()).toString('hex');

    // Hot key — random, held outside the SDK keystore. On extension/desktop
    // this is the JS fallback (serialized AuthSecretKey hex); on mobile it is
    // wrapped under SE (iOS) or Keystore/StrongBox (Android) inside the native
    // plugin and surfaces here only as opaque ciphertext.
    const hot = await secureHotKey.generateHotKey();

    // Get Guardian endpoint and initialize client. Onboarding always threads the
    // picked endpoint as the override (stage 1 of #408); with no override we use
    // the effective network default. The frozen global GUARDIAN_URL_STORAGE_KEY
    // is intentionally NOT consulted here (#408 stage 3) — a NEW account must
    // never inherit a stale global pointer.
    const guardianEndpoint = guardianEndpointOverride ?? getEffectiveDefaultGuardianEndpoint();

    const client = new MultisigClient(webClient, {
      guardianEndpoint,
      midenRpcEndpoint: getEffectiveRpcUrl()
    });
    // Both guardian calls count against its per-IP rate limit, which users
    // behind a shared egress IP (NAT, VPN) share; a 429 is waited out within
    // GUARDIAN_CREATE_RATE_LIMIT_BUDGET_MS, one deadline for both calls (#906).
    const rateLimitDeadline = monotonicNowMs() + GUARDIAN_CREATE_RATE_LIMIT_BUDGET_MS;
    const afterWait = () => assertLive('after a guardian 429 wait');
    // Not yet bound to an account: on mobile its origin routes through native HTTP
    // while its key is read, and for the session only once that key is a Guardian's.
    // Every attempt carries its own deadline: the 429 deadline bounds only the waits.
    const { commitment: guardianCommitment, pubkey: guardianPubkey } = await withGuardianProbe(
      guardianEndpoint,
      async () => {
        const answer = await withGuardianRateLimitRetry(
          () =>
            withTimeout(
              client.guardianClient.getPubkey('ecdsa'),
              NEW_GUARDIAN_PUBKEY_TIMEOUT_MS,
              `Guardian ${guardianEndpoint} pubkey fetch`
            ),
          { deadlineMs: rateLimitDeadline, sleepFn: sleepKeepingWorkerAlive, afterWait }
        );
        return { ...answer, commitment: assertGuardianKeyCommitment(answer.commitment, guardianEndpoint) };
      }
    );
    assertLive('before the account build');
    // Signer order is [hot, cold] by convention — the migration plan diagrams
    // and downstream role-routing code assume this layout.
    const multisig = await client.create(
      {
        threshold: 1,
        signerCommitments: [hot.commitmentHex, coldCommitmentHex],
        guardianCommitment,
        guardianPublicKey: guardianPubkey,
        // No `guardianEnabled` since multisig-client 0.17: the builder now
        // rejects a config without a guardian commitment outright, so every
        // account it creates is guarded and the flag had nothing left to
        // select. We only ever passed `true`, so behavior is unchanged.
        storageMode: 'private',
        signatureScheme: 'ecdsa',
        seed: coldSeed,
        procedureThresholds: [
          {
            procedure: 'update_guardian',
            threshold: 2
          },
          // `update_procedure_threshold` edits the overrides, so it has to cost
          // at least as much as the strictest one it can lower. Left at the
          // account threshold of 1, the hardening above was decorative: either
          // single signer could drop `update_guardian` back to 1 and then
          // switch the guardian alone. Enforced by the builder (and by
          // `AuthMultisig::new` on the Rust side) since multisig-client 0.17,
          // which rejects the unguarded shape outright.
          {
            procedure: 'update_procedure_threshold',
            threshold: 2
          }
        ]
      },
      new EcdsaSigner(coldSk)
    );

    if (!skipRegistration) {
      assertLive('before guardian registration');
      await withGuardianRateLimitRetry(() => multisig.registerOnGuardian(), {
        deadlineMs: rateLimitDeadline,
        sleepFn: sleepKeepingWorkerAlive,
        afterWait
      });
    }
    assertLive('before the sync');
    await webClient.sync();

    // Cold goes through the standard SDK keystore so the WASM client can sign
    // with it on demand; the existing insertKeyCallback wraps it under the
    // vault key and stores it at accAuthSecretKeyStrgKey(coldPublicKey).
    // Hot is intentionally NOT inserted here — vault.ts persists the
    // returned hot ciphertext separately under its own envelope.
    assertLive('before the cold key insert');
    await webClient.keystore.insert(multisig.account.id(), coldSk);

    console.log('Guardian account created:', multisig.account.id().toString());

    return {
      account: multisig.account,
      keys: {
        hotPublicKey: hot.publicKeyHex,
        coldPublicKey,
        hotCiphertext: hot.ciphertext,
        coldSecretKeyHex
      },
      guardianEndpoint
    };
  } catch (e) {
    // The lock's kill classifiers read the poison error's identity; wrapped, an
    // abandoned flow would read as a flat failure.
    if (isWasmClientPoisonedError(e)) throw e;
    console.error('Error creating Guardian account:', e);
    // Preserve the original cause so callers can distinguish guardian-unreachable
    // from node/registration/WASM failures.
    throw new Error('Failed to create Guardian account', { cause: e });
  }
}
