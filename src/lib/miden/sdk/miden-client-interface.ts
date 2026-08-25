import {
  Account,
  AccountFile,
  Address,
  AuthSecretKey,
  Endpoint,
  type ConsumableNoteRecord,
  exportStore,
  getWasmOrThrow,
  importStore,
  InputNote,
  InputNoteRecord,
  InputNoteState,
  MidenClient,
  Note,
  NoteDetails,
  NoteExportFormat,
  NoteFile,
  NoteQuery,
  type NoteInclusionProof,
  RpcClient,
  NoteType,
  TransactionProver,
  TransactionRequest,
  TransactionResult,
  WasmWebClient
} from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearConnectivityIssue, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { isOffscreenAvailable, proveViaOffscreen } from 'lib/miden/back/offscreen-prover';
import { getSpeculationManager, type SpeculationParams } from 'lib/miden/back/speculation-manager';
import {
  getEffectiveNetworkName,
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { isMobile } from 'lib/platform';
import type { AuthScheme } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { NoteExportType } from './constants';
import { type ConsumableNoteDto, reduceConsumableNoteRecords } from './consumable-notes';
import {
  accountRefToSdk,
  buildPswapCreateRequest,
  buildSendTransactionRequest,
  getBech32AddressFromAccountId,
  walletAccountIdToSdk
} from './helpers';
import { withWasmLockWatchdogPaused, yieldWasmClientLock } from './miden-client';
import { buildNativeProverCallback } from './native-prover-mobile';
import { recordProveTelemetry } from './prove-telemetry';
import { isApplyAfterSubmitError } from './sdk-error-code';
import { ConsumeTransaction, ITransactionStage, SendTransaction, SwapTransaction } from '../db/types';
// Guardian helpers are dynamic-imported inside the methods that use them to avoid
// a module init cycle: miden-client-interface → guardian/index → sdk/miden-client →
// miden-client-interface. Static imports here deadlock init_guardian_manager in the
// SW bundle (both sides' __esmMin wrappers await each other).
// guardian/native-http is cycle-safe (it only pulls constants + platform).
import { insertGuardianAccountMonotonically, type CreatedGuardianKeys } from '../guardian/account';
import { registerGuardianOrigin } from '../guardian/native-http';
import { isPrivateNoteType } from '../helpers';

export interface GuardianAccountCreationResult {
  accountId: string;
  keys: CreatedGuardianKeys;
  // Guardian operator endpoint the account was registered with — persisted onto
  // the WalletAccount so runtime endpoint resolution is per-account.
  guardianEndpoint: string;
}

/**
 * One Guardian account discovered + adopted via lookup-based recovery. The
 * orchestrator does NOT rotate the hot signer at recovery time — the on-chain
 * hot pubkey's secret is unrecoverable, but the wallet defers replacement
 * until the user explicitly opts in (via the post-recovery banner on the
 * home view). Vault.spawn persists `coldSecretKeyHex` under
 * `accColdSecretKeyStrgKey(coldPublicKey)` and writes the WalletAccount
 * with `requiresHotKeyRotation: true` and no `hotPublicKey` — the rotation
 * flow (initiateReplaceHotKeyTransaction) generates the fresh hot key when
 * the user clicks the banner.
 */
export interface RecoveredGuardianAccount {
  accountId: string;
  hdIndex: number;
  coldPublicKey: string;
  coldSecretKeyHex: string;
}

const MAX_RECOVERY_HD_INDEX = 20;
// Tolerate a few consecutive empty HD indices before concluding there are no
// more accounts — handles a non-contiguous index set or a transient empty
// guardian response, matching BIP-44 wallet gap-limit conventions.
const RECOVERY_GAP_LIMIT = 3;

// E2E-build only. The per-step prove-timing markers are useful for the
// Playwright harness (it polls __PROVE_TIMINGS__ to drive its step
// machine) but pure noise in normal users' devtools.
const PROVE_TIMING_ENABLED = process.env.MIDEN_E2E_TEST === 'true';

function recordProveTiming(message: string): void {
  if (!PROVE_TIMING_ENABLED) return;
  const line = `[prove-timing] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const g = globalThis as unknown as { __PROVE_TIMINGS__?: string[] };
    if (!g.__PROVE_TIMINGS__) g.__PROVE_TIMINGS__ = [];
    g.__PROVE_TIMINGS__.push(`${Date.now()}|${line}`);
  } catch {
    // ignore — non-global context (web worker etc.)
  }
}

/**
 * Feature flag: when true, local proving is dispatched to a
 * `chrome.offscreen` document with a wasm-bindgen-rayon thread pool
 * (~3.5× faster than the SW's single-threaded prove on a 10-core machine).
 *
 * **Default ON for desktop chrome builds** (vite.background.config.ts and
 * vite.extension.config.ts default the env to `'true'`). Mobile builds
 * (vite.mobile.config.ts) hardcode this to `'false'` because Capacitor /
 * WKWebView / Android WebView don't expose `chrome.offscreen` — the
 * runtime guard `isOffscreenAvailable()` would also fall through, but
 * fixing the build-time constant lets dead-code elimination drop the
 * offscreen import entirely from the mobile bundle.
 *
 * Opt out per-build (e.g. to bisect a regression suspected to live in
 * the offscreen path) with `MIDEN_USE_OFFSCREEN_PROVING=false`.
 */
const USE_OFFSCREEN_PROVING = process.env.MIDEN_USE_OFFSCREEN_PROVING === 'true';

export type MidenClientCreateOptions = {
  seed?: Uint8Array;
  insertKeyCallback?: (key: Uint8Array, secretKey: Uint8Array) => void;
  getKeyCallback?: (key: Uint8Array) => Promise<Uint8Array>;
  signCallback?: (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>;
  onConnectivityIssue?: () => void;
  /**
   * Override the SDK's Web-Worker shim (issue #260, slice 5, design §5.2).
   * Defaults to `!isMobile()` (the historical behavior). The offscreen document
   * passes `false` so its client runs on the doc's own multi-threaded main-thread
   * WASM instance (rayon pool) instead of a method-worker with an un-pooled
   * single-threaded instance — required for MT proving in-realm AND for the
   * keystore sign callback / `lastAuthError` to be reachable (both are
   * "meaningful only with `useWorker:false`" per the SDK).
   */
  useWorker?: boolean;
};

// Re-export the slice-4 consumable-note DTO from the interface too, so callers
// that already import note types from here get it in one place.
export type { ConsumableNoteAsset, ConsumableNoteDto } from './consumable-notes';

export type InputNoteDetails = {
  noteId: string;
  senderAccountId: string | undefined;
  assets: FungibleAssetDetails[];
  noteType: NoteType | undefined;
  nullifier: string;
  state: InputNoteState;
};

export type FungibleAssetDetails = {
  amount: string;
  faucetId: string;
};

/**
 * One public-backfill op's outcome. The two "come back for more" signals are
 * mutually exclusive:
 *
 * `saturated` — the BLOCK RANGE was too big for one op; retry it as halves.
 * `nextNoteOffset` — the range was fine but held more notes than one op imports;
 * re-offer the SAME range starting at this note index. Absent means finished.
 */
export type RecoveryRangeResult = {
  imported: number;
  failures: number;
  saturated: boolean;
  nextNoteOffset?: number;
};

/**
 * Resolves note bytes to a {@link NoteFile} for import.
 *
 * The import path consumes a serialized `NoteFile`, but callers (notably a dApp's
 * `ConsumeTransaction` `noteBytes`, whose type is just `Uint8Array` with no
 * documented format) commonly pass a serialized `Note` — the natural output of
 * `note.serialize()`. Both are accepted: a `NoteFile` is used directly, and a
 * bare `Note` is wrapped into a `NoteFile` (the `NoteDetails` variant, matching
 * what `NoteFile.fromInputNote` produces when no inclusion proof is available).
 * Bytes that are neither raise a clear, actionable error instead of the opaque
 * `notefile deserialization failed: invalid utf-8 sequence...` that surfaces when
 * `Note` bytes are fed straight into `NoteFile.deserialize`.
 *
 * The wrapped variant is the `NoteDetails` one, so the note is stored as
 * `Expected` until a sync commits it — and it is wrapped with the note's REAL
 * tag (`metadata().tag()`), because that tag is the only thing that can commit
 * it. `client.notes.import` resolves an expected note by asking the node for the
 * notes carrying the file's tag between its after-block hint and the chain tip,
 * and it subscribes the client to that tag for later syncs. On 0.16
 * `NoteFile.fromNoteDetails` — what this used to call — is documented as using
 * "a zero-valued sync hint": it asks for tag 0 instead of the note's own tag, so
 * the node returns nothing for it and an already-committed private note stayed
 * `Expected` forever (absent from the claimable list, never consumable), leaving
 * a dead tag-0 subscription riding every later sync request. Block 0 is the after-block hint because a bare
 * `Note` carries no block information; scanning from genesis is slower than a
 * real hint but correct.
 */
/**
 * Bracket a keystore sign callback with a WASM-lock-watchdog pause (issue
 * #775): the sign fires from inside the SDK mid-execute, while the caller's
 * `withWasmClientLock` hold is live, and can wait as long as the user takes to
 * authenticate. Wall-clock spent signing must not count against the watchdog
 * ceiling.
 */
function wrapSignWithWatchdogPause(
  sign: (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>
): (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array> {
  return (publicKey, signingInputs) => withWasmLockWatchdogPaused(() => sign(publicKey, signingInputs));
}

function deserializeNoteFileOrNote(noteBytes: Uint8Array): NoteFile {
  try {
    return NoteFile.deserialize(noteBytes);
  } catch (noteFileError) {
    let note: Note;
    try {
      note = Note.deserialize(noteBytes);
    } catch (noteError) {
      const noteFileDetail = noteFileError instanceof Error ? noteFileError.message : String(noteFileError);
      const noteDetail = noteError instanceof Error ? noteError.message : String(noteError);
      throw new Error(
        'importNoteBytes: bytes are neither a serialized NoteFile nor a serialized Note ' +
          `(NoteFile parse error: ${noteFileDetail}; Note parse error: ${noteDetail}). ` +
          'Pass noteFile.serialize() or note.serialize().'
      );
    }
    return NoteFile.fromExpectedNote(new NoteDetails(note.assets(), note.recipient()), note.metadata().tag(), 0);
  }
}

export class MidenClientInterface {
  client: MidenClient;
  network: string;

  private constructor(client: MidenClient, network: string) {
    this.client = client;
    this.network = network;
  }

  static async create(options: MidenClientCreateOptions = {}) {
    const network = getEffectiveNetworkName();

    if (process.env.MIDEN_USE_MOCK_CLIENT === 'true') {
      const sdk = await import('@miden-sdk/miden-sdk/lazy');
      const mockClient = await sdk.MidenClient.createMock({ seed: options.seed });
      return new MidenClientInterface(mockClient, 'mock');
    }

    const hasKeystore = !!(options.getKeyCallback || options.insertKeyCallback || options.signCallback);

    const midenClient = await MidenClient.create({
      rpcUrl: getEffectiveRpcUrl(),
      noteTransportUrl: getEffectiveNoteTransportUrl(),
      seed: options.seed,
      keystore: hasKeystore
        ? {
            getKey: options.getKeyCallback!,
            insertKey: options.insertKeyCallback!,
            // A sign round-trip can block indefinitely on the user (Face ID,
            // an unlock prompt) while the WASM lock is held — pause the lock
            // watchdog for its duration so a slow sign is never mistaken for
            // a wedge (issue #775; mirrors the offscreen write deadline's
            // sign pause in miden-client-proxy.ts).
            sign: options.signCallback ? wrapSignWithWatchdogPause(options.signCallback) : options.signCallback!
          }
        : undefined,
      proverUrl: getEffectiveProverUrl(),
      // On mobile (Capacitor / WKWebView / Android WebView) we MUST opt out
      // of the SDK's Web-Worker shim. Two independent reasons:
      //
      // 1. The shim spawns a worker that owns its own WASM instance and
      //    runs every client method (including `syncState()`) inside the
      //    worker — and WKWebView Workers cannot do gRPC-web fetch
      //    (documented in `mobile-wasm-main-thread.md` memory). The shim
      //    hangs sync, `lastSyncedAt` freezes, no consumable notes ever
      //    surface. Empirically: run 25779923813 saw `isSyncing: true`
      //    with `msSinceLastSync: 184s` at failure time. See PR #240.
      //
      // 2. We hand the SDK a `CallbackProver` that routes prove calls
      //    through the native Rust prover via a Capacitor plugin. The
      //    shim serializes the prover via `.serialize()` — a format with
      //    no encoding for the callback variant — and silently downgrades
      //    it to `"local"`, running an in-worker WASM ST prover and
      //    bypassing the native bridge. Opt out so the callback survives.
      //
      // The `useWorker` option lands in `@miden-sdk/miden-sdk@0.14.9`
      // (web-sdk PR #149). Default `!isMobile()`; the offscreen document
      // overrides to `false` (issue #260, slice 5, design §5.2 — see
      // MidenClientCreateOptions.useWorker).
      useWorker: options.useWorker ?? !isMobile()
    });

    return new MidenClientInterface(midenClient, network);
  }

  static fromClient(client: MidenClient, network: string) {
    return new MidenClientInterface(client, network);
  }

  free() {
    this.disposed = true;
    this.client.terminate();
  }

  /** Set by `free()` — see `yieldLockUnlessDisposed`. */
  private disposed = false;

  /**
   * `yieldWasmClientLock`, unless this client has been disposed (issue #775).
   * Lock recovery always disposes the client BEFORE releasing the mutex, so a
   * disposed `this` marks the running flow as an evicted corpse — the lock it
   * thinks it holds now belongs to someone else, and yielding would release
   * that innocent holder's lock into a concurrent WASM call. Run the operation
   * without touching the mutex instead; the flow fails loudly at its next call
   * against the terminated client.
   */
  private yieldLockUnlessDisposed<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return operation();
    return yieldWasmClientLock(operation);
  }

  async createMidenWallet(walletType: WalletType, seed?: Uint8Array, auth?: AuthScheme): Promise<string> {
    if (walletType === WalletType.Guardian) {
      // NOTE: Guardian creation never reaches here — Vault.spawn and
      // createHDAccount always route Guardian to createGuardianMidenWallet
      // (which threads the picked endpoint). This branch passes no endpoint
      // override, so createGuardianAccount binds to the network default (the
      // frozen global key is no longer consulted for NEW accounts — #408
      // stage 3). If anything ever routes Guardian through createMidenWallet for
      // a non-default operator, thread the per-account endpoint here.
      const { createGuardianAccount } = await import('../guardian/account');
      const { account } = await createGuardianAccount(this.client, seed);
      return getBech32AddressFromAccountId(account.id());
    }

    const isPublic = walletType === WalletType.OnChain;
    const wallet: Account = await this.client.accounts.create({
      storage: isPublic ? 'public' : 'private',
      seed,
      // Forward `auth` only when explicitly set so the SDK default (still
      // Falcon, matching the historical wallet default) governs any
      // path that hasn't been migrated to choose a scheme.
      ...(auth ? { auth } : {})
    });
    return getBech32AddressFromAccountId(wallet.id());
  }

  /**
   * Create a 3-key Guardian account. Returns the account ID alongside the hot
   * ciphertext + cold secret-key bytes the wallet must persist (vault wraps
   * both before writing them to storage).
   */
  async createGuardianMidenWallet(
    coldSeed?: Uint8Array,
    guardianEndpoint?: string
  ): Promise<GuardianAccountCreationResult> {
    const { createGuardianAccount } = await import('../guardian/account');
    // Forward the caller's picked endpoint as the override so the account binds
    // to it (stage 1 of #408). When undefined, createGuardianAccount binds to
    // the network default (the frozen global key is no longer consulted for NEW
    // accounts — #408 stage 3).
    const {
      account,
      keys,
      guardianEndpoint: usedEndpoint
    } = await createGuardianAccount(this.client, coldSeed, false, guardianEndpoint);
    return { accountId: getBech32AddressFromAccountId(account.id()), keys, guardianEndpoint: usedEndpoint };
  }

  async importMidenWallet(accountBytes: Uint8Array): Promise<string> {
    const accountFile = AccountFile.deserialize(accountBytes);
    const wallet: Account = await this.client.accounts.import({ file: accountFile });
    return getBech32AddressFromAccountId(wallet.id());
  }

  async importPublicMidenWalletFromSeed(seed: Uint8Array, auth?: AuthScheme) {
    // The SDK reconstructs the account from `seed` + `auth` (default Falcon
    // when omitted). For the wallet's mnemonic-restore path the caller
    // PROBES with each known auth scheme to find which account id actually
    // exists on chain — see `Vault.spawn`. Forwarding `auth` only when
    // explicitly provided keeps any other call site behaving exactly as
    // before.
    const account = await this.client.accounts.import({
      seed,
      ...(auth ? { auth } : {})
    });
    return getBech32AddressFromAccountId(account.id());
  }

  async importAccountBySeed(seed: Uint8Array): Promise<string> {
    return await this.importPublicMidenWalletFromSeed(seed);
  }

  /**
   * Discover and adopt all Guardian accounts authorized by the cold keys
   * derived from `mnemonic` against `guardianEndpoint`. Iterates HD indices
   * 0..MAX-1 and stops after RECOVERY_GAP_LIMIT consecutive empty indices (so a
   * small gap doesn't silently drop later accounts).
   *
   * Each match is adopted locally only: the on-chain Account state is
   * decoded and inserted into the WASM client + the cold key registered in
   * the keystore. The hot signer is NOT rotated here — the on-chain hot
   * pubkey's secret is unrecoverable, but rotation is deferred to a
   * user-triggered banner action on the home view (initiateReplaceHotKey).
   * The persisted WalletAccount is flagged `requiresHotKeyRotation: true`
   * and carries no `hotPublicKey` until the rotation completes.
   *
   * The orchestrator acquires the WASM client mutex granularly per op, so
   * callers must NOT hold the outer lock.
   *
   * @param deriveColdSeed - Sync closure returning the HD-derived cold seed
   *   for a given index. Supplied by Vault.spawn so the BIP-39 / HD-path
   *   logic stays out of this module (avoids a vault → miden-client-interface
   *   import cycle).
   * @param guardianEndpoint - Operator the lookup is scoped to. Must match
   *   the endpoint the account was originally registered with — account IDs
   *   are content-hash bound to the guardian pubkey baked into storage.
   */
  async recoverGuardianAccountsBySeed(
    deriveColdSeed: (hdIndex: number) => Uint8Array,
    guardianEndpoint: string
  ): Promise<RecoveredGuardianAccount[]> {
    const [{ withWasmClientLock }, { MultisigClient, EcdsaSigner }] = await Promise.all([
      import('../sdk/miden-client'),
      import('@openzeppelin/miden-multisig-client')
    ]);

    const recovered: RecoveredGuardianAccount[] = [];
    let consecutiveMisses = 0;

    registerGuardianOrigin(guardianEndpoint);
    for (let hdIndex = 0; hdIndex < MAX_RECOVERY_HD_INDEX; hdIndex++) {
      const coldSeed = deriveColdSeed(hdIndex);
      const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
      const coldPublicKey = Buffer.from(coldSk.publicKey().serialize().slice(1)).toString('hex');
      const coldSecretKeyHex = Buffer.from(coldSk.serialize()).toString('hex');

      const lookupClient = new MultisigClient(this.client, {
        guardianEndpoint,
        midenRpcEndpoint: getEffectiveRpcUrl()
      });
      const lookupSigner = new EcdsaSigner(coldSk);
      const matches = await lookupClient.recoverByKey(lookupSigner);

      if (matches.length === 0) {
        // Tolerate a small gap before giving up, so a non-contiguous index or a
        // transient empty guardian response doesn't silently drop later accounts.
        consecutiveMisses++;
        if (consecutiveMisses >= RECOVERY_GAP_LIMIT) break;
        continue;
      }
      consecutiveMisses = 0;

      for (const { state } of matches) {
        // Decode the on-chain account state and adopt it locally so subsequent
        // SDK calls (.load, executeForSummary) can resolve the account.
        const accountBytes = new Uint8Array(Buffer.from(state.stateJson.data, 'base64'));
        const bech32 = await withWasmClientLock(async () => {
          const acc = Account.deserialize(accountBytes);
          // The same account matches at more than one HD index, so this runs
          // twice per recovery; a plain overwrite lets whichever snapshot
          // arrives last win, including a creation-time one.
          await insertGuardianAccountMonotonically(this.client, acc);
          await this.client.keystore.insert(acc.id(), coldSk);
          return getBech32AddressFromAccountId(acc.id());
        });

        recovered.push({
          accountId: bech32,
          hdIndex,
          coldPublicKey,
          coldSecretKeyHex
        });
      }
    }

    if (recovered.length === 0) {
      throw new Error('No Guardian accounts found at this guardian endpoint for this seed');
    }

    return recovered;
  }

  /**
   * Imports a serialized note (NoteFile or raw Note bytes) into the client.
   *
   * Resolves to a hex string: the note ID for a metadata-bearing file, or
   * the details commitment for a details-only file. The wallet's
   * `deserializeNoteFileOrNote` wraps raw `Note` bytes into the details variant
   * (`NoteFile.fromExpectedNote`), so for that path the returned hex is a
   * details commitment, not a note ID.
   */
  async importNoteBytes(noteBytes: Uint8Array): Promise<string> {
    const noteFile = deserializeNoteFileOrNote(noteBytes);
    // String(...) tolerates both return shapes across the 0.15 alpha line:
    // alpha.4 resolves a NoteId object, current `next` resolves the hex
    // string directly.
    return String(await this.client.notes.import(noteFile));
  }

  /**
   * Pending-note recovery source 1 of 3: drain the private-note transport
   * backlog into the store. Kept a standalone short op (the SW orchestrates
   * the sources as separate offscreen calls) so nothing holds the WASM mutex
   * long enough for queued reads to deadline-kill the realm.
   */
  async drainPrivateNoteTransport(): Promise<void> {
    // Cursor-based, NOT a from-zero drain: SDK 0.16 removed the `{ mode: 'all' }`
    // full-fetch this originally used, so a note the recipient's stored cursor has
    // already advanced past is not recoverable through this path. The bounded
    // sender-side re-push (`note-delivery-sweep.ts`) is what covers that case.
    await this.client.notes.fetchPrivate();
  }

  /**
   * Pending-note recovery source 2 of 3: import serialized notes recovered
   * from pending Guardian `consume_notes` proposals, attaching a node-fetched
   * inclusion proof when one exists.
   */
  async importRecoveryNoteBytes(proposalNoteBytes: Uint8Array[]): Promise<{ imported: number; failures: number }> {
    const rpc = new RpcClient(new Endpoint(getEffectiveRpcUrl()));
    let imported = 0;
    let failures = 0;

    const notes: Note[] = [];
    for (const noteBytes of proposalNoteBytes) {
      try {
        notes.push(Note.deserialize(noteBytes));
      } catch (error) {
        failures++;
        console.warn('[GuardianRecovery] Failed to deserialize one proposal note:', error);
      }
    }

    // ONE proof lookup for the whole batch, not one per note. Per-note lookups
    // with the default one-retry budget meant a wedged node cost up to 30s ×
    // batch size inside a single WASM-mutex hold — and on mobile and desktop
    // that hold has no op deadline to cut it short, so every other wallet
    // operation, including a transaction the user is waiting on, stalls for all
    // of it. `retries: 0` for the same reason the other recovery reads use it.
    // A failed lookup is not fatal: the notes import as Expected instead.
    const proofs = new Map<string, NoteInclusionProof>();
    if (notes.length > 0) {
      try {
        const fetched = await withRpcTimeout(
          () => rpc.getNotesById(notes.map(note => note.id())),
          'recoveryProposalNoteProofs',
          { retries: 0 }
        );
        // Keyed by id rather than trusting position: `getNotesById` may answer
        // short or reordered (the public backfill counts on that too).
        for (const entry of fetched) {
          const proof = entry?.inclusionProof;
          if (proof) proofs.set(String(entry.noteId), proof);
        }
      } catch (error) {
        console.warn('[GuardianRecovery] Proposal note proof lookup failed; importing as Expected:', error);
      }
    }

    // One import per distinct id. A batch holding the same note twice — which
    // the Guardian, not this wallet, decides — would otherwise hand the same
    // proof to `authenticated` twice, and the second call gets a handle the
    // first one already moved into Rust. Re-importing is a no-op anyway.
    const imports = new Set<string>();
    for (const note of notes) {
      try {
        const noteId = String(note.id());
        if (imports.has(noteId)) continue;
        imports.add(noteId);
        const inclusionProof = proofs.get(noteId);
        const inputNote = inclusionProof
          ? InputNote.authenticated(note, inclusionProof)
          : InputNote.unauthenticated(note);
        await this.client.notes.import(NoteFile.fromInputNote(inputNote));
        imported++;
      } catch (error) {
        failures++;
        console.warn('[GuardianRecovery] Failed to import one proposal note:', error);
      }
    }
    return { imported, failures };
  }

  /**
   * Resolve the public-backfill scan range for a recovered account: binary
   * search block headers for the first block minted after the account was
   * created (Guardian `createdAt`, seconds), with a margin for clock skew.
   * Scanning from the creation block instead of genesis keeps the backfill
   * proportional to the account's age.
   */
  async resolveRecoveryScanRange(createdAtSeconds: number): Promise<{ startBlock: number; latestBlock: number }> {
    const rpc = new RpcClient(new Endpoint(getEffectiveRpcUrl()));
    // ~log2(tip) sequential header reads, so each one gets a short bound and no
    // retry: a slow node must not spend the caller's whole op deadline here,
    // and the recovery retries the whole range on the next backend start.
    const header = (blockNum?: number) =>
      withRpcTimeout(() => rpc.getBlockHeaderByNumber(blockNum), 'recoveryScanRangeHeader', {
        timeoutMs: 8_000,
        retries: 0
      });

    const latestHeader = await header();
    const latestBlock = latestHeader.blockNum();
    const clockSkewMarginSeconds = 600;
    const target = createdAtSeconds - clockSkewMarginSeconds;
    if (target <= 0) return { startBlock: 0, latestBlock };
    // Timestamps only ever NARROW the scan, and this scan runs once: whatever
    // it skips is skipped forever, because a clean pass clears the one-shot
    // pending flag. `createdAt` comes from the Guardian operator's clock and the
    // headers come from the node, so every way those two can disagree is
    // resolved by scanning MORE, never less.
    if (latestHeader.timestamp() <= target) {
      // The account claims to be newer than the chain tip, yet it demonstrably
      // exists on that chain. One of the two clocks is wrong; starting at the
      // tip would scan a single block, find nothing, and report success. A node
      // that reports no tip timestamp at all lands here too, since `target` is
      // positive by this point.
      console.warn(
        `[GuardianRecovery] Reported creation time is at or beyond the chain tip (tip ` +
          `${latestHeader.timestamp()}, target ${target}); scanning from genesis instead`
      );
      return { startBlock: 0, latestBlock };
    }
    const genesis = await header(0);
    if (genesis.timestamp() >= target) return { startBlock: 0, latestBlock };
    // Invariant: timestamp(lo) < target <= timestamp(hi).
    let lo = 0;
    let hi = latestBlock;
    // Deadline as well as a bisection bound: this whole method runs inside one
    // mutex-held op, and ~log2(tip) reads at 8s each would blow well past the
    // 60s the chunking design budgets for an op. Stopping early only widens the
    // scan — `lo` is always a block older than the account, which is exactly
    // what the backfill needs — so a slow node costs extra scanned blocks
    // rather than a wedged wallet.
    const searchDeadline = Date.now() + 20_000;
    while (lo + 1 < hi) {
      if (Date.now() > searchDeadline) {
        console.warn(
          `[GuardianRecovery] Creation-block search ran out of budget; scanning from block ${lo} (widened range)`
        );
        break;
      }
      const mid = lo + Math.floor((hi - lo) / 2);
      const midHeader = await header(mid);
      const midTimestamp = midHeader.timestamp();
      // The bisection is only valid over monotonically increasing timestamps.
      // A zero or absent one breaks that invariant and would push `lo` past the
      // account's real creation block, silently skipping its history.
      if (midTimestamp <= 0) {
        console.warn(`[GuardianRecovery] Block ${mid} reported no timestamp; scanning from genesis instead`);
        return { startBlock: 0, latestBlock };
      }
      if (midTimestamp < target) lo = mid;
      else hi = mid;
    }
    return { startBlock: lo, latestBlock };
  }

  /**
   * Pending-note recovery source 3 of 3: import committed public notes whose
   * tag matches the account, over ONE bounded block range. The SW walks the
   * full creation-to-tip span in chunks through this method so progress is
   * reportable and the WASM mutex is released between chunks.
   *
   * `saturated` means "this range is too big to do in one op, hand me halves":
   * either the node refused the span, or the range holds more tag matches than
   * one op should import. Narrowing is the CALLER's job, not this method's —
   * every dispatch of it runs under the WASM mutex with the SW's write deadline
   * already armed (`offscreen/main.ts` `handleCall`), so work it does not
   * finish inside that one op has to come back as another op, not as recursion
   * inside this one.
   */
  async recoverPublicNotesRange(
    accountId: string,
    blockFrom: number,
    blockTo: number,
    noteOffset = 0
  ): Promise<RecoveryRangeResult> {
    const rpc = new RpcClient(new Endpoint(getEffectiveRpcUrl()));
    const accountSdkId = walletAccountIdToSdk(accountId);
    const noteTag = Address.fromAccountId(accountSdkId).toNoteTag();
    return this.recoverPublicNotesInRange(rpc, noteTag, blockFrom, blockTo, noteOffset);
  }

  /**
   * Span at or below which a range is no longer narrowed. A dense range still
   * has to be imported eventually, and past this point narrowing has stopped
   * helping (a single block cannot be split); such a range is paged by note
   * count instead, via `nextNoteOffset`.
   */
  private static readonly MIN_SPLIT_SPAN_BLOCKS = 1_000;

  /**
   * Tag matches one op will import. Past this it reports `saturated` and
   * imports nothing, so the caller can come back with halves: on mobile and
   * desktop the op runs inline with no deadline, so an unbounded note count is
   * an unbounded WASM-mutex hold — every wallet operation behind it, including
   * a transaction the user is waiting on, stalls for its duration.
   */
  private static readonly MAX_NOTES_PER_CHUNK = 200;

  /**
   * A node that refuses the requested span because it is too wide is reported
   * as saturated so the caller can retry halves; anything else propagates.
   * Rate limiting must NOT land here:
   * "429 Too Many Requests" would otherwise be read as a span complaint and
   * answered by doubling the number of requests.
   */
  private static isBlockSpanTooWide(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const rateLimited =
      message.includes('too many requests') ||
      message.includes('rate limit') ||
      message.includes('resource exhausted') ||
      message.includes('resourceexhausted') ||
      message.includes('429');
    if (rateLimited) return false;
    return (
      message.includes('paginationerror') ||
      message.includes('blockpagination') ||
      message.includes('safety cap') ||
      (message.includes('block') && (message.includes('too many') || message.includes('maximum number')))
    );
  }

  private async recoverPublicNotesInRange(
    rpc: RpcClient,
    noteTag: ReturnType<Address['toNoteTag']>,
    blockFrom: number,
    blockTo: number,
    noteOffset: number
  ): Promise<RecoveryRangeResult> {
    const span = blockTo - blockFrom + 1;
    const splittable = span > MidenClientInterface.MIN_SPLIT_SPAN_BLOCKS;

    let syncInfo;
    try {
      // Bounded, no retry: an unbounded await here hangs the WASM mutex on the
      // inline (mobile/desktop) path, where no op deadline exists to kill it.
      // The no-retry part is also load-bearing for correctness: this call MOVES
      // `noteTag` into Rust, so a second attempt would hand it a dead handle.
      syncInfo = await withRpcTimeout(() => rpc.syncNotes(blockFrom, blockTo, [noteTag]), 'recoverySyncNotes', {
        timeoutMs: 30_000,
        retries: 0
      });
    } catch (error) {
      if (splittable && MidenClientInterface.isBlockSpanTooWide(error)) {
        return { imported: 0, failures: 0, saturated: true };
      }
      throw error;
    }

    const allCommittedNotes = syncInfo.notes();
    if (splittable && allCommittedNotes.length > MidenClientInterface.MAX_NOTES_PER_CHUNK) {
      // Nothing imported on purpose: the halves re-scan their own sub-ranges,
      // and importing a prefix here would only be repeated work (imports are
      // idempotent) while still holding the mutex for the whole prefix.
      console.log(
        `[GuardianRecovery] Public backfill blocks ${blockFrom}-${blockTo}: ${allCommittedNotes.length} tag matches ` +
          `exceeds ${MidenClientInterface.MAX_NOTES_PER_CHUNK} per op; asking the caller for a narrower range`
      );
      return { imported: 0, failures: 0, saturated: true };
    }

    // Below the split floor a dense range cannot be narrowed further, so it is
    // paged by NOTE instead: the op imports at most `MAX_NOTES_PER_CHUNK` and
    // hands back where to continue. Without this, an unsplittable window holding
    // thousands of matches — which anyone can arrange, since a note tag is a
    // truncated commitment and volume can be aimed at a victim's — is one
    // unbounded op: on the extension it outlives its deadline, the realm is
    // killed, the orchestrator reads that as a deferral and retries the SAME
    // window forever; on mobile and desktop it holds the only WASM mutex for as
    // long as it takes.
    const committedNotes = allCommittedNotes.slice(noteOffset, noteOffset + MidenClientInterface.MAX_NOTES_PER_CHUNK);
    const consumedTo = noteOffset + committedNotes.length;
    const nextNoteOffset = consumedTo < allCommittedNotes.length ? consumedTo : undefined;

    let imported = 0;
    let failures = 0;
    // A PRIVATE tag match carries no body over RPC by design (the SDK documents
    // `note` as undefined for private notes). It belongs to the transport drain
    // (source 1), so it is not a failure of this source.
    let skippedPrivate = 0;
    let unexpected = 0;
    const fetchBatchSize = 100;
    for (let start = 0; start < committedNotes.length; start += fetchBatchSize) {
      const noteIds = committedNotes.slice(start, start + fetchBatchSize).map(note => note.noteId());
      // Read BEFORE the call: passing these into `getNotesById` MOVES them into
      // Rust (wasm-bindgen unwraps every element and zeroes the JS wrapper's
      // pointer), so afterwards each one is a dead handle and stringifying it
      // traps. Only the array's length survives the call.
      //
      // Resolved BY ID, not by count. A response of the right length can still
      // be the wrong notes — duplicates of one id, or ids never asked for —
      // and counting length alone would read that as a clean chunk, letting
      // the orchestrator clear the one-shot flag over notes never imported.
      const requestedIds = new Set(noteIds.map(String));
      const fetchedNotes = await withRpcTimeout(() => rpc.getNotesById(noteIds), 'recoveryGetNotesById', {
        retries: 0
      });
      const answeredIds = new Set<string>();
      for (const fetched of fetchedNotes) {
        const noteId = String(fetched.noteId);
        if (!requestedIds.has(noteId) || answeredIds.has(noteId)) {
          unexpected++;
          continue;
        }
        answeredIds.add(noteId);
        const inputNote = fetched.asInputNote();
        if (!inputNote) {
          // A body-less PUBLIC note is the node failing to serve what it said
          // it had, not an expected private note.
          if (fetched.noteType === NoteType.Public) {
            failures++;
            console.warn(`[GuardianRecovery] Node returned public note ${noteId} without a body`);
          } else {
            skippedPrivate++;
          }
          continue;
        }
        try {
          await this.client.notes.import(NoteFile.fromInputNote(inputNote));
          imported++;
        } catch (error) {
          failures++;
          console.warn('[GuardianRecovery] Failed to import one public note:', error);
        }
      }
      failures += noteIds.length - answeredIds.size;
    }
    console.log(
      `[GuardianRecovery] Public backfill blocks ${blockFrom}-${blockTo} notes ${noteOffset}-${consumedTo} of ` +
        `${allCommittedNotes.length} tag matches: ${imported} imported, ${skippedPrivate} private, ` +
        `${unexpected} unrequested/duplicate, ${failures} failed`
    );
    return { imported, failures, saturated: false, nextNoteOffset };
  }

  async getAccount(accountId: string) {
    return await this.client.accounts.get(accountId);
  }

  async importAccountById(accountId: string) {
    return await this.client.accounts.import(accountId);
  }

  async getAccounts() {
    return await this.client.accounts.list();
  }

  async getInputNote(noteId: string): Promise<InputNoteRecord | null> {
    return await this.client.notes.get(noteId);
  }

  async getInputNotes(query?: NoteQuery): Promise<InputNoteRecord[]> {
    return await this.client.notes.list(query);
  }

  async getInputNoteDetails(query?: NoteQuery): Promise<InputNoteDetails[]> {
    const allInputNotes = await this.client.notes.list(query);
    return allInputNotes.flatMap(note => {
      // A partial (metadata-less) record has no note ID — and, since 0.15
      // nullifiers fold in metadata, no nullifier either. It cannot be
      // displayed or consumed, so skip it until sync completes it.
      const noteId = note.id();
      const nullifier = note.nullifier();
      if (!noteId || !nullifier) {
        return [];
      }
      const assets = note
        .details()
        .assets()
        .fungibleAssets()
        .map(asset => ({
          amount: asset.amount().toString(),
          faucetId: getBech32AddressFromAccountId(asset.faucetId())
        }));
      const noteMet = note.metadata();
      return [
        {
          noteId: noteId.toString(),
          noteType: noteMet?.noteType(),
          senderAccountId: noteMet ? getBech32AddressFromAccountId(noteMet.sender()) : undefined,
          nullifier,
          state: note.state(),
          assets
        }
      ];
    });
  }

  async syncState() {
    return await this.client.sync();
  }

  async exportNote(noteId: string, exportType: NoteExportType): Promise<Uint8Array> {
    const formatMap: Record<string, NoteExportFormat> = {
      [NoteExportType.ID]: NoteExportFormat.Id,
      [NoteExportType.FULL]: NoteExportFormat.Full,
      [NoteExportType.DETAILS]: NoteExportFormat.Details
    };
    const result = await this.client.notes.export(noteId, { format: formatMap[exportType] ?? NoteExportFormat.Full });
    return result.serialize();
  }

  async sendPrivateNote(note: Note, to: string): Promise<void> {
    // 0.16: sendPrivate requires an explicit scan-after block hint. For one of this client's
    // own output notes, sendPrivateOutput derives that hint from the note's stored expected
    // height, so the recipient scans from at/below the note's commitment block.
    await this.client.notes.sendPrivateOutput({ noteId: note.id().toString(), to });
  }

  /**
   * Relay a private output note identified only by its id.
   *
   * Same call as {@link sendPrivateNote}, minus the live `Note`. The re-push sweep
   * runs long after the sending session ended and has nothing but the persisted
   * transaction row, so requiring a `Note` would mean re-hydrating one purely to
   * read back the id that `sendPrivateOutput` wants anyway.
   *
   * Safe to call repeatedly: the hint is re-derived from the note's stored
   * `expected_height` on every call, so a re-push is as correct as the first push
   * however late it runs.
   */
  async relayPrivateNoteById(noteId: string, to: string): Promise<void> {
    await this.client.notes.sendPrivateOutput({ noteId, to });
  }

  /**
   * Whether one of this client's own output notes has been consumed on chain.
   *
   * This is the wallet's only positive proof that a PRIVATE note was delivered.
   * The chain shows a commitment, never the note body, so the recipient cannot
   * consume a private note without having received that body through the
   * transport — which makes the nullifier a delivery receipt. Everything else
   * available to the sender (a transport ACK, a landed transaction) is consistent
   * with the recipient never seeing the note at all.
   *
   * Unknown ids answer `false` rather than throwing: the sweep treats "not proven
   * delivered" as the safe reading, and a row whose note this client no longer
   * tracks should not wedge it.
   */
  async isOutputNoteConsumed(noteId: string): Promise<boolean> {
    const [record] = await this.client.notes.listSent({ ids: [noteId] });
    return record !== undefined && record.isConsumed();
  }

  /**
   * Consumable notes reduced to plain, JSON-safe {@link ConsumableNoteDto}s
   * (issue #260, slice 4).
   *
   * This is the DTO-returning form the offscreen proxy routes through. Its whole
   * point is that the reclaim gate inside {@link getConsumableNotes}
   * (`consumableAfterBlock() <= getSyncHeight()`) AND the per-note reduction run
   * in the SAME realm — so when the flag is on and `syncState` ran offscreen, the
   * gate uses the offscreen (sync-running) realm's height rather than a stale
   * SW-inline height. The reduction is behavior-preserving: it relocates the exact
   * reach-through the callers used into one shared reducer.
   */
  async getConsumableNoteDtos(accountId: string): Promise<ConsumableNoteDto[]> {
    const records = await this.getConsumableNotes(accountId);
    const syncHeight = await this.client.getSyncHeight();
    return reduceConsumableNoteRecords(records, syncHeight);
  }

  async getConsumableNotes(accountId: string): Promise<InputNoteRecord[]> {
    // Use the consumability-annotated listing (raw WebClient) instead of the
    // bare `notes.listAvailable`: a sender-side P2IDE note is "available" but
    // only consumable-as-reclaimer AFTER its reclaim height. The bare listing
    // surfaced those as claimable-now, so consume attempts before the height
    // fail on the kernel's reclaim assertion (#308's 126 failed attempts).
    // Drop every note whose consumability for this account starts at a future
    // block; once the height is reached it reappears and becomes recallable.
    // NOTE: a note whose reclaim height is ALREADY reached is consumable-now
    // by design and passes this filter — self-sends (where auto-consume would
    // claim the note right back) are blocked at the send-flow entry instead.
    //
    // Reads through a transient raw WasmWebClient (same IndexedDB store as
    // the main client, separate WASM object so it can't trip the
    // single-threaded aliasing guard) — the SDK wrapper exposes no
    // consumability-annotated listing.
    //
    // `useWorker` is pinned to `false` (the SDK's 6th positional parameter; its
    // default is `true`). It must be explicit because this line runs in TWO
    // realms: in the MV3 service worker `Worker` is undefined so the SDK silently
    // takes the in-realm path, but the offscreen document — where this now runs
    // whenever MIDEN_USE_OFFSCREEN_CLIENT is on, which is the Chrome default for
    // the SW bundle — IS a real document, so the default would spawn a Web Worker
    // and a SECOND multi-threaded WASM instance inside the offscreen doc on every
    // sync tick, claimable-notes refresh and dApp note query, then tear it down.
    // `useWorker:false` still yields a DISTINCT wasm-bindgen client object, so the
    // aliasing protection this transient read relies on is unchanged; it just
    // stops paying for a worker + WASM instantiation per call.
    if (this.network === 'mock') {
      return await this.client.notes.listAvailable({ account: accountId });
    }
    const wasm = await getWasmOrThrow();
    const syncHeight = await this.client.getSyncHeight();
    const inner = await WasmWebClient.createClient(
      getEffectiveRpcUrl(),
      undefined,
      undefined,
      undefined,
      undefined,
      false
    );
    try {
      const records: ConsumableNoteRecord[] = await inner.getConsumableNotes(resolveAccountId(wasm, accountId));
      return records
        .filter(record => {
          // One consumability entry per relevant account; we queried a single
          // account, so any entry gated on a future block hides the note.
          // `consumableAfterBlock()` is undefined for consumable-now (and for
          // never-consumable — those keep the pre-existing behavior).
          const gatedUntil = record
            .noteConsumability()
            .map(entry => entry.consumptionStatus().consumableAfterBlock())
            .find(after => after !== undefined);
          return gatedUntil === undefined || gatedUntil <= syncHeight;
        })
        .map(record => record.inputNoteRecord());
    } finally {
      inner.terminate();
    }
  }

  async sendTransaction(
    dbTransaction: SendTransaction,
    onStage?: (stage: ITransactionStage) => Promise<void> | void
  ): Promise<TransactionResult> {
    const { accountId, secondaryAccountId, faucetId, noteType, amount, extraInputs } = dbTransaction;

    // extraInputs.recallBlocks is a RELATIVE blocks-until-recall offset (every
    // producer — send UI, dApp path, epoch bridge — passes an offset). This is
    // the ONE place it becomes an absolute reclaim height; the SDK bakes
    // `reclaimAfter` verbatim into the P2IDE note inputs. Adding an
    // already-absolute value here doubles the chain height and makes recall
    // fail for days (#308).
    let reclaimAfter: number | undefined;
    if (extraInputs?.recallBlocks) {
      const syncResult = await this.client.sync();
      reclaimAfter = syncResult.blockNum() + extraInputs.recallBlocks;
    }

    return proveWithFallback(async (prover, attempt) => {
      if (this.shouldUseOffscreenProver(prover)) {
        // SpeculationParams MUST hash identically to whatever the popup
        // sent in SPECULATE_SEND_REQUEST so the cache hits. We skip the
        // cache when reclaimAfter is set (block-height drift between
        // speculate-time and commit-time would invalidate the cached
        // reclaim height — corner case, easier to skip than handle).
        const cacheParams: SpeculationParams | undefined =
          reclaimAfter == null
            ? {
                accountId,
                recipientAccountId: secondaryAccountId,
                faucetId,
                // Same coercion the request builder uses, so the key can't say
                // 'public' for a note built Private (and vice versa).
                noteType: isPrivateNoteType(noteType) ? 'private' : 'public',
                amount: BigInt(amount)
              }
            : undefined;
        return await this.proveLocallyViaOffscreen(
          (wasm, inner) =>
            buildSendExecuteArgs(wasm, inner, accountId, secondaryAccountId, faucetId, noteType, amount, reclaimAfter),
          attempt,
          cacheParams,
          onStage
        );
      }
      // Non-offscreen path (mobile native prover, desktop WASM, delegated
      // remote): the SDK's all-in-one `transactions.send` runs execute+prove+
      // submit inside one opaque call, leaving no seam to stamp `proving`/
      // `submitting`. Drive the staged execute → prove → submit → apply pipeline
      // instead so the per-step timing UI gets real stage boundaries on every
      // platform. Build the SAME request the atomic path builds
      // (`buildSendExecuteArgs`), serialized across the SDK lock boundary and
      // re-hydrated for execution (a wasm-bindgen request can't be shared across
      // lock re-acquisitions; the bytes can).
      const wasm = await getWasmOrThrow();
      const withInner = (
        this.client as unknown as {
          _withInnerWebClient?: <T>(fn: (inner: any) => Promise<T>) => Promise<T>;
        }
      )._withInnerWebClient;
      if (typeof withInner !== 'function') {
        throw new Error('_withInnerWebClient missing from @miden-sdk/miden-sdk; expected version 0.15.5 or newer.');
      }
      // `_withInnerWebClient` is untyped (accessed through the cast above), so
      // its result widens to `unknown` — the same reason the offscreen path
      // below narrows its returned `TransactionResult`. The callback returns the
      // serialized request bytes, which cross the lock boundary safely (a live
      // wasm-bindgen request can't).
      const requestBytes = (await withInner.call(this.client, async (inner: any) => {
        const { request } = await buildSendExecuteArgs(
          wasm,
          inner,
          accountId,
          secondaryAccountId,
          faucetId,
          noteType,
          amount,
          reclaimAfter
        );
        return request.serialize();
      })) as Uint8Array;
      await onStage?.('executing');
      // The canonical id, which is what `buildSendExecuteArgs` read the vault
      // under. Executing against the raw `accountId` would let the account the
      // request runs on diverge from the one its asset's vault key came from —
      // the mismatch that silently reinstates the callback-flag bug — and would
      // reject the composite `<address>_<suffix>` form the read accepts.
      const executed = await this.client.transactions.executeRequest(
        walletAccountIdToSdk(accountId).toString(),
        TransactionRequest.deserialize(requestBytes)
      );
      await onStage?.('proving');
      const proven = await executed.prove(prover ? { prover } : {});
      await onStage?.('submitting');
      // Point of no return: everything below can put this transfer on chain, so a
      // failure past here must NOT be retried with the local prover — the retry
      // would build a fresh request (new note serial) and submit a SECOND send.
      attempt.markSubmitting();
      const submitted = await proven.submit();
      await submitted.apply();
      return executed.result;
    }, dbTransaction.delegateTransaction);
  }

  /**
   * Run execute + offscreen prove for the given speculation params, return
   * the serialized bytes WITHOUT submitting or applying. The wallet's
   * SpeculationManager calls this when the user is on the review screen
   * and we want to pre-prove for likely-confirm. The returned bytes get
   * cached and consumed by `proveLocallyViaOffscreen` on actual submit
   * (skipping a full re-execute + re-prove).
   *
   * Caveat: this DOES touch the SW's WASM client (executeTransaction
   * mutates account state). If the user backs out of review, the
   * speculation's effects on the SW's account state are discarded only
   * because we never submit/apply — the executed-but-not-applied state
   * sits in the TransactionResult bytes. submitProvenTransaction +
   * applyTransaction are what actually persist; without them the
   * speculation has zero on-chain or local-DB effect.
   */
  async executeAndProveForSpeculation(params: SpeculationParams) {
    if (!isOffscreenAvailable()) {
      throw new Error('executeAndProveForSpeculation called without chrome.offscreen available');
    }
    const wasm = await getWasmOrThrow();
    const withInner = (
      this.client as unknown as {
        _withInnerWebClient?: <T>(fn: (inner: any) => Promise<T>) => Promise<T>;
      }
    )._withInnerWebClient;
    if (typeof withInner !== 'function') {
      throw new Error('_withInnerWebClient missing from @miden-sdk/miden-sdk; expected version 0.15.5 or newer.');
    }
    // Build args + execute under the SDK's serialization lock. The lock is
    // released between this block and the offscreen prove so background sync
    // can run during the ~10s prove wait.
    const txResult = (await withInner.call(this.client, async (inner: any) => {
      const { accountId, request } = await buildSendExecuteArgs(
        wasm,
        inner,
        params.accountId,
        params.recipientAccountId,
        params.faucetId,
        params.noteType,
        params.amount.toString(),
        undefined
      );
      return (await inner.executeTransaction(accountId, request)) as TransactionResult;
    })) as TransactionResult;
    const txResultBytes = txResult.serialize();
    // Tag as speculative so SpeculationManager.abortSpeculativeProve() can
    // terminate the offscreen doc to interrupt this prove if the user's
    // form params change before it finishes. Non-speculative proves bump
    // a counter that blocks the abort path — they must run to completion.
    const { provenBytes, durationMs } = await this.yieldLockUnlessDisposed(() =>
      proveViaOffscreen(txResultBytes, null, { speculative: true })
    );
    console.log(`[speculation] pre-proved tx in ${durationMs.toFixed(0)}ms`);
    return {
      paramsHash: speculationParamsHash(params),
      txResultBytes,
      provenBytes: new Uint8Array(provenBytes)
    };
  }

  async consumeNoteId(transaction: ConsumeTransaction): Promise<TransactionResult> {
    const { accountId, noteId, noteIds } = transaction;

    // Batch claims consume every note in one transaction (one proof/submit).
    const targetNoteIds = noteIds && noteIds.length > 0 ? noteIds : [noteId];

    recordProveTiming(`consumeNoteId entered noteId=${noteId} delegateTransaction=${transaction.delegateTransaction}`);
    return proveWithFallback(async (prover, attempt) => {
      recordProveTiming(`consumeNoteId closure entered, prover=${prover ? 'set' : 'undefined'}`);
      if (this.shouldUseOffscreenProver(prover)) {
        return await this.proveLocallyViaOffscreen(async (wasm, inner) => {
          // The bundled `transactions.consume` resolves string note IDs via
          // `inner.getInputNote(...)` and unwraps to `Note` via `.toNote()`,
          // then passes a plain JS array `Note[]` to
          // `newConsumeTransactionRequest`. wasm-bindgen converts the
          // array to Vec<Note> internally — DO NOT use `wasm.NoteArray`
          // here. wasm.NoteArray is a different wasm-bindgen type (a
          // pre-built Vec<Note> handle); the request builder accepts the
          // JS array form, and passing the typed-array handle silently
          // produces a tx with zero input notes (the prove succeeds, then
          // completeConsumeTransaction trips on `inputNotes().notes()[0]`
          // being undefined).
          const notes: Note[] = [];
          for (const id of targetNoteIds) {
            recordProveTiming('consumeNoteId buildExecuteArgs: calling getInputNote');
            const inputNoteRecord = await inner.getInputNote(id);
            recordProveTiming(`consumeNoteId buildExecuteArgs: getInputNote returned, found=${!!inputNoteRecord}`);
            if (!inputNoteRecord) {
              throw new Error(`Note ${id} not found in store`);
            }
            notes.push(inputNoteRecord.toNote());
          }
          recordProveTiming('consumeNoteId buildExecuteArgs: toNote done; calling newConsumeTransactionRequest');
          const request: TransactionRequest = await inner.newConsumeTransactionRequest(notes);
          recordProveTiming('consumeNoteId buildExecuteArgs: newConsumeTransactionRequest returned');
          const acctId = resolveAccountId(wasm, accountId);
          recordProveTiming('consumeNoteId buildExecuteArgs: resolveAccountId returned');
          return { accountId: acctId, request };
        }, attempt);
      }
      // The ONLY caller that deliberately does NOT call `attempt.markSubmitting()`
      // before an opaque whole-op SDK write, i.e. the only one that still permits a
      // whole-op local-prover retry. Two properties make that safe here and nowhere
      // else: (1) the retry consumes the SAME input notes, so if the first attempt
      // did reach the chain the second is rejected on the spent nullifier rather
      // than duplicating value — unlike a send/swap, whose retry mints a new output
      // note with a fresh serial; (2) the apply-after-submit failure (submitted,
      // local store update failed) is excluded from the retry by
      // `proveWithFallback`'s `isApplyAfterSubmitError` gate, so that row still
      // classifies as landed. Keeping the retry matters because consume is the
      // wallet's highest-frequency write (auto-claim) and the remote prover's ~10s
      // deadline is its most common failure.
      recordProveTiming('consumeNoteId calling SDK client.transactions.consume');
      try {
        const { result } = await this.client.transactions.consume({
          account: accountId,
          notes: targetNoteIds,
          prover
        });
        recordProveTiming('consumeNoteId SDK consume returned');
        return result;
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        recordProveTiming(`consumeNoteId SDK consume THREW ${detail}`);
        throw error;
      }
    }, transaction.delegateTransaction);
  }

  /**
   * Create a partial-swap (PSWAP) note offering one fungible asset in
   * exchange for another. The creator locks `offeredAmount` of
   * `offeredFaucetId`; a filler later consumes the note and pays back
   * `requestedAmount` of `requestedFaucetId` (partial fills emit a
   * remainder PSWAP note for the unfilled amount).
   *
   * TODO: offscreen-prover path not wired up — pswapCreate has no
   * `buildExecuteArgs` builder yet, so this always proves inline via
   * `withProverFallback`. Add the offscreen path if swap proving is slow.
   */
  async swapTransaction(transaction: SwapTransaction): Promise<TransactionResult> {
    const { accountId, faucetId, amount, extraInputs } = transaction;

    const withInner = (
      this.client as unknown as {
        _withInnerWebClient?: <T>(fn: (inner: any) => Promise<T>) => Promise<T>;
      }
    )._withInnerWebClient;
    if (typeof withInner !== 'function') {
      throw new Error('_withInnerWebClient missing from @miden-sdk/miden-sdk; expected version 0.15.5 or newer.');
    }

    return proveWithFallback(async (prover, attempt) => {
      // `transactions.pswapCreate` would build, prove and submit in one call, but
      // it builds the offered asset from faucet id + amount and so always offers
      // the Disabled callback variant — see `buildPswapCreateRequest`. Split the
      // build out so the note can be re-emitted against the vault key the
      // creator actually holds, then submit that instead.
      //
      // The canonical id for both the vault read and the submit, for the reason
      // spelled out on the send path above: the account a request is EXECUTED
      // against must be the one its asset's vault key came from.
      const canonicalId = walletAccountIdToSdk(accountId).toString();
      const creatorAccount = await this.client.accounts.get(canonicalId);
      const reference = (await withInner.call(this.client, async (inner: any) =>
        inner.newPswapCreateTransactionRequest(
          walletAccountIdToSdk(accountId),
          accountRefToSdk(faucetId),
          BigInt(amount),
          accountRefToSdk(extraInputs.requestedFaucetId),
          BigInt(extraInputs.requestedAmount),
          NoteType.Public,
          NoteType.Public
        )
      )) as TransactionRequest;
      const request = buildPswapCreateRequest(creatorAccount ?? undefined, reference, faucetId, BigInt(amount));
      // Point of no return. `submit` executes, proves and submits in one call, so
      // a whole-op retry past here would draw a fresh serial from
      // `newPswapCreateTransactionRequest` above, build a SECOND PSWAP note and
      // lock the offered asset twice. Marking it costs this swap its
      // delegated→local prove fallback; a duplicated swap note is unrecoverable,
      // a failed swap is not.
      attempt.markSubmitting();
      const { result } = await this.client.transactions.submit(canonicalId, request, { prover });
      return result;
    }, transaction.delegateTransaction);
  }

  async newTransaction(
    accountId: string,
    requestBytes: Uint8Array,
    delegateTransaction?: boolean
  ): Promise<TransactionResult> {
    return proveWithFallback(async (prover, attempt) => {
      if (this.shouldUseOffscreenProver(prover)) {
        return await this.proveLocallyViaOffscreen(async wasm => {
          // `inner.executeTransaction` consumes both args by value, so every
          // attempt hydrates its OWN request from the bytes — a shared handle
          // would be moved-from the second time it was used.
          const request = TransactionRequest.deserialize(requestBytes);
          const acctId = resolveAccountId(wasm, accountId);
          return { accountId: acctId, request };
        }, attempt);
      }
      // Staged execute → prove → submit → apply rather than the all-in-one
      // `transactions.submit`, for the same reason the send path is staged: it
      // gives the prove-fallback a seam to stop at, so a failure at or after
      // submit can never be retried into a second broadcast of this request
      // (dApp custom transactions and the Agglayer bridged-send both land here).
      // Each attempt deserializes its own request — a wasm-bindgen request is
      // consumed by execution, so a shared handle would be moved-from on a retry.
      const executed = await this.client.transactions.executeRequest(
        accountId,
        TransactionRequest.deserialize(requestBytes)
      );
      const proven = await executed.prove(prover ? { prover } : {});
      attempt.markSubmitting();
      const submitted = await proven.submit();
      await submitted.apply();
      return executed.result;
    }, delegateTransaction);
  }

  /**
   * Decide whether this prove call should be dispatched to the offscreen
   * document or stay on the SDK's bundled path inside the SW. Returns true
   * iff: the build opted into offscreen proving (MIDEN_USE_OFFSCREEN_PROVING),
   * the host environment exposes chrome.offscreen (Chrome MV3 only — Firefox
   * + Safari don't), AND the prover is local (delegated/remote stays on
   * the SDK's bundled path since it's just an RPC).
   *
   * Any false → prove runs on the SW's WASM instance (single-threaded but
   * still produces correct proofs). Lets us ship the offscreen path off by
   * default and turn it on per-build, with a clean fallback for browsers
   * that don't support the offscreen API at all.
   */
  private shouldUseOffscreenProver(prover: TransactionProver | undefined): boolean {
    if (!USE_OFFSCREEN_PROVING) return false;
    if (!isOffscreenAvailable()) return false;
    if (!prover) return false;
    return isLocalProver(prover);
  }

  /**
   * Run execute → offscreen prove → submit → apply for a transaction whose
   * `(accountId, request)` is built by the caller. Splits the SDK's bundled
   * pipeline so the prove step can execute in a chrome.offscreen document
   * where the rayon thread pool actually has threads to run on.
   *
   * Around the offscreen call we use `yieldWasmClientLock` to release the
   * SW's WASM client mutex — the prove happens on a separate WASM instance
   * in the offscreen doc, so background sync can run during the ~10s wait
   * without contending. Without this, sync's 10s timeout fires roughly
   * once per prove and surfaces a "can't reach node" toast.
   */
  private async proveLocallyViaOffscreen(
    buildExecuteArgs: (wasm: any, inner: any) => Promise<{ accountId: any; request: TransactionRequest }>,
    attempt: ProveAttempt,
    cacheParams?: SpeculationParams,
    onStage?: (stage: ITransactionStage) => Promise<void> | void
  ): Promise<TransactionResult> {
    try {
      recordProveTiming('proveLocallyViaOffscreen entered');
      const wasm = await getWasmOrThrow();
      recordProveTiming('proveLocallyViaOffscreen got wasm');
      const withInner = (
        this.client as unknown as {
          _withInnerWebClient?: <T>(fn: (inner: any) => Promise<T>) => Promise<T>;
        }
      )._withInnerWebClient;
      if (typeof withInner !== 'function') {
        throw new Error('_withInnerWebClient missing from @miden-sdk/miden-sdk; expected version 0.15.5 or newer.');
      }
      recordProveTiming('proveLocallyViaOffscreen got withInner');

      // Speculation cache hit path: if the popup pre-proved this exact tx
      // while the user was on the review screen, the SpeculationManager
      // has the result. Skip execute + prove and go straight to submit +
      // apply (~250ms total instead of ~10s). consumeCacheHit removes
      // the entry so a stale result can't be reused.
      //
      // Cache-miss-but-in-flight: if a matching speculation is currently
      // executing/proving (user clicked Confirm before it finished), wait
      // for it instead of doing a duplicate execute + prove. We yield the
      // WASM client lock during the wait — speculation's
      // executeAndProveForSpeculation also takes that lock, so without
      // yielding we'd deadlock with whoever holds it (i.e. ourselves).
      if (cacheParams) {
        const mgr = getSpeculationManager();
        let hit = mgr?.consumeCacheHit(cacheParams);
        if (!hit && mgr?.hasInFlightMatching(cacheParams)) {
          const tWait = performance.now();
          await this.yieldLockUnlessDisposed(() => mgr.awaitMatching(cacheParams));
          hit = mgr.consumeCacheHit(cacheParams);
          console.log(
            `[mt-offscreen-prove] awaited in-flight speculation ${(performance.now() - tWait).toFixed(0)}ms hit=${!!hit}`
          );
        }
        if (hit) {
          // Proof came from a speculation cache hit (pre-proved on the review
          // screen), so there's no live prove step to time — stamp only submit.
          await onStage?.('submitting');
          // Point of no return — see the identical mark on the inline send path.
          attempt.markSubmitting();
          const result = (await withInner.call(this.client, async (inner: any) => {
            const txResult: TransactionResult = wasm.TransactionResult.deserialize(hit.txResultBytes);
            const proven = wasm.ProvenTransaction.deserialize(hit.provenBytes);
            const height = await inner.submitProvenTransaction(proven, txResult);
            await inner.applyTransaction(txResult, height);
            return txResult;
          })) as TransactionResult;
          console.log('[mt-offscreen-prove] tx_completed via_speculation=true');
          return result;
        }
      }

      // Build args + execute under the SDK lock. We hold the lock here, drop
      // it for the offscreen prove (~10s wait, separate WASM instance — no
      // shared state), then re-acquire it for submit + apply. Returning the
      // TransactionResult handle out of the first block is safe: it's a
      // wasm-bindgen reference, alive as long as the JS reference exists,
      // and the next block re-uses it without a fresh WASM call.
      await onStage?.('executing');
      recordProveTiming('proveLocallyViaOffscreen entering execute under SDK lock');
      const tExec = performance.now();
      const txResult = (await withInner.call(this.client, async (inner: any) => {
        recordProveTiming('proveLocallyViaOffscreen inside SDK lock; building exec args');
        const { accountId, request } = await buildExecuteArgs(wasm, inner);
        recordProveTiming('proveLocallyViaOffscreen built exec args; calling executeTransaction');
        const r = (await inner.executeTransaction(accountId, request)) as TransactionResult;
        recordProveTiming(
          `proveLocallyViaOffscreen executeTransaction returned in ${(performance.now() - tExec).toFixed(0)}ms`
        );
        return r;
      })) as TransactionResult;
      recordProveTiming('proveLocallyViaOffscreen exited SDK-lock execute block; serializing');
      const txResultBytes = txResult.serialize();
      recordProveTiming(
        `proveLocallyViaOffscreen serialized txResult (${txResultBytes.length} bytes); yielding lock + proveViaOffscreen`
      );
      // Yield the SW's WASM lock during the offscreen prove. The SDK's
      // _withInnerWebClient lock is already released here (we left the
      // first block), so background sync can run.
      await onStage?.('proving');
      const { provenBytes, durationMs } = await this.yieldLockUnlessDisposed(() =>
        proveViaOffscreen(txResultBytes, null)
      );
      recordProveTiming(
        `proveLocallyViaOffscreen proveViaOffscreen returned in ${durationMs.toFixed(0)}ms (lock reacquired); submitting + applying`
      );
      await onStage?.('submitting');
      // Point of no return — see the identical mark on the inline send path.
      attempt.markSubmitting();
      await withInner.call(this.client, async (inner: any) => {
        recordProveTiming('proveLocallyViaOffscreen inside SDK lock; deserializing proven + submit');
        const proven = wasm.ProvenTransaction.deserialize(new Uint8Array(provenBytes));
        const height = await inner.submitProvenTransaction(proven, txResult);
        recordProveTiming(`proveLocallyViaOffscreen submit returned height=${height}; applying`);
        await inner.applyTransaction(txResult, height);
        recordProveTiming('proveLocallyViaOffscreen apply returned');
      });
      console.log(`[mt-offscreen-prove] tx_completed prove_ms=${durationMs.toFixed(0)}`);
      return txResult;
    } catch (err) {
      console.error('[mt-offscreen-prove] FAILED', err);
      throw err;
    }
  }

  async exportDb() {
    const storeName = await this.client.storeIdentifier();
    return await exportStore(storeName);
  }

  async importDb(dump: string) {
    const storeName = await this.client.storeIdentifier();
    await importStore(storeName, dump);
  }

  async getTransactionsForAccount(accountId: string) {
    const transactions = await this.client.transactions.list();
    return transactions.filter(tx => getBech32AddressFromAccountId(tx.accountId()) === accountId);
  }

  /**
   * Node-authoritative commit state of a specific transaction (by hex id).
   *
   *   - `'committed'` the tx is on chain (TransactionStatus has a block number).
   *   - `'pending'`   the tx is locally known but not yet committed (still in
   *                   the mempool / awaiting a block) — it was submitted.
   *   - `'not-found'` no local record — INDETERMINATE. The tx may have landed on
   *                   chain without this client recording it (e.g. an offscreen
   *                   write killed after submit but before apply), so a caller
   *                   MUST NOT treat this as "definitely didn't land".
   *
   * Used by the send/swap idempotent-retry guard (transaction/cancel.ts
   * `verifySendLanded`) so a Failed row whose original submit actually landed is
   * never blindly resubmitted (double-send). Mirrors the note-state authority of
   * `verifyConsumeLanded` but for the OUTPUT side, keyed on the tx id.
   */
  async getTransactionCommitState(txId: string): Promise<'committed' | 'pending' | 'not-found'> {
    const transactions = await this.client.transactions.list();
    const record = transactions.find(tx => tx.id().toHex() === txId);
    if (!record) return 'not-found';
    return record.transactionStatus().getBlockNum() !== undefined ? 'committed' : 'pending';
  }

  async waitForTransactionCommit(
    transactionId: string,
    maxWaitMs: number = 60_000,
    delayMs: number = 5_000
  ): Promise<void> {
    await this.client.transactions.waitFor(transactionId, { timeout: maxWaitMs, interval: delayMs });
  }
}

/**
 * Handed to every `proveWithFallback` callback so it can declare its point of no
 * return. See {@link proveWithFallback} for why that matters.
 */
export interface ProveAttempt {
  /**
   * MUST be called immediately before the attempt's first irreversible network
   * write (`submit`). After it is called, `proveWithFallback` will never re-run
   * the callback — a retry could otherwise broadcast the transaction twice.
   */
  markSubmitting(): void;
}

/**
 * Select the prover and run `fn(prover, attempt)` for a transaction. Shared by
 * EVERY wallet transaction path (guardian and non-guardian) so proving behaves
 * identically everywhere:
 *  - delegate (setting on) → `fn(undefined, …)`, so the caller proves via its
 *    remote prover; on failure, fall back to the local/native prover below.
 *  - otherwise → `fn(localProver, …)`, where localProver is the native Rust prover
 *    on mobile (off the main thread via @miden/native-prover) and the WASM local
 *    prover on desktop/extension.
 *
 * On mobile we must NEVER prove with WASM on the main thread — it freezes the UI
 * for the whole multi-second prove. Callers driving the raw inner WebClient
 * directly (the guardian pipeline) must pass an explicit remote prover in the
 * delegate branch, since the raw client's default prover is the main-thread WASM
 * one; see `generateGuardianTransaction`.
 *
 * FUNDS SAFETY — why the fallback is gated. `fn` is not a prove step: for every
 * caller it also SUBMITS and APPLIES. Retrying it wholesale after a failure at or
 * after `submit()` re-broadcasts the transaction — with a freshly built request
 * (a new random note serial, so a different output note that the node has no
 * reason to reject as a duplicate), debiting the user twice for one transfer. It
 * also destroyed the apply-after-submit classification: the original error was
 * discarded in favour of the retry's, so `isApplyAfterSubmitError` no longer fired
 * and a transfer that IS on chain was marked Failed, then re-queued by the user's
 * Retry into a third send. So the retry runs ONLY when the attempt provably never
 * reached submit: `attempt.markSubmitting()` was not called AND the error is not
 * the SDK's apply-after-submit variant (belt and braces — a caller whose write is
 * opaque, with no seam to mark, must call `markSubmitting()` before it). The
 * guardian pipelines (`runGuardianPipeline`, offscreen `guardianPipeline`) get
 * this right structurally by re-proving the SAME executed transaction; the
 * gate is how the callers that own their whole write reach the same guarantee.
 */
export async function proveWithFallback<T>(
  fn: (prover: TransactionProver | undefined, attempt: ProveAttempt) => Promise<T>,
  delegateTransaction?: boolean
): Promise<T> {
  recordProveTiming(`withProverFallback entered delegateTransaction=${delegateTransaction}`);
  const shouldDelegate = delegateTransaction === true;

  // Mobile builds prove via the native iOS / Android Capacitor plugin
  // (@miden/native-prover) instead of WASM. iOS WKWebView can't be made
  // crossOriginIsolated under Capacitor 8, so the MT WASM bundle can't
  // instantiate; rather than fall back to (very slow) ST WASM, we
  // route to a native Rust prover linked into the app. Same wire
  // format as RemoteTransactionProver — bytes in, bytes out — so the
  // SDK dispatch path is unchanged downstream.
  const localProverFactory = (): TransactionProver => {
    if (isMobile()) {
      return TransactionProver.newCallbackProver(buildNativeProverCallback());
    }
    return TransactionProver.newLocalProver();
  };

  // Flipped by the callback right before its first irreversible write. Read in
  // the catch below to decide whether a retry is safe — see the docstring.
  let submitReached = false;
  const attempt: ProveAttempt = {
    markSubmitting: () => {
      submitReached = true;
    }
  };

  const startedAt = performance.now();
  try {
    // A local prove attempt pauses the lock watchdog: local proving is
    // deliberately unbounded (it is the fallback when delegated proving is
    // down — capping it would leave nothing to fall back to). The delegated
    // attempt stays on the clock. Issue #775.
    const result = !shouldDelegate
      ? await withWasmLockWatchdogPaused(() => fn(localProverFactory(), attempt))
      : await fn(undefined, attempt);
    const pathLabel = shouldDelegate ? 'delegate' : isMobile() ? 'native-mobile' : 'local';
    const durationMs = performance.now() - startedAt;
    recordProveTiming(
      `path=${pathLabel} duration_ms=${durationMs.toFixed(1)} platform=${isMobile() ? 'mobile' : 'desktop'}`
    );
    // #466: always-on structured timing so an occasional 20s+ prove is visible.
    recordProveTelemetry({ path: pathLabel, durationMs, fellBack: false });
    // A successful prover call (whether local or remote) means the prover
    // pathway the wallet actually uses is healthy. If we'd previously
    // marked the prover as down, clear it now — the old design never
    // cleared and the banner pinned forever after a single transient 502.
    clearConnectivityIssue('prover');
    return result;
  } catch (err) {
    // `submitReached` / `isApplyAfterSubmitError`: the attempt got far enough that
    // re-running it could broadcast the transaction a second time. Propagate the
    // ORIGINAL error untouched so `generateTransactionsLoop`'s
    // `isApplyAfterSubmitError` classification still sees it.
    if (shouldDelegate && !submitReached && !isApplyAfterSubmitError(err)) {
      const remoteDurationMs = performance.now() - startedAt;
      // The remote prover path failed. Whether or not we can fall back
      // locally, the user-facing surface should know remote proving is
      // unavailable. Only categorize transport-shaped errors so we
      // don't trip the banner on semantic WASM errors (e.g. "note has
      // already been consumed").
      if (isLikelyNetworkError(err)) {
        markConnectivityIssue('prover');
      }
      // Fall back to the local path. On mobile this is the native
      // Rust prover; on desktop / extension it's the WASM local prover.
      recordProveTiming('delegate failed, retrying with local prover');
      const fallbackStartedAt = performance.now();
      const fallbackPath = isMobile() ? 'native-mobile' : 'local';
      try {
        const result = await withWasmLockWatchdogPaused(() => fn(localProverFactory(), attempt));
        recordProveTiming(
          `path=${fallbackPath}-fallback duration_ms=${(performance.now() - fallbackStartedAt).toFixed(1)}`
        );
        // #466: the user waited for the stalled remote attempt AND the local
        // re-prove — record the total wall time + the remote portion, since this
        // remote→local doubling is the prime 20s+ suspect.
        recordProveTelemetry({
          path: fallbackPath,
          durationMs: performance.now() - startedAt,
          fellBack: true,
          remoteDurationMs
        });
        return result;
      } catch (fallbackErr) {
        // Both remote and local proving failed — a 20s+ that ends in failure is
        // exactly the worst #466 case, so record it before the error propagates.
        recordProveTelemetry({
          path: fallbackPath,
          durationMs: performance.now() - startedAt,
          fellBack: true,
          remoteDurationMs,
          failed: true
        });
        // Keep the remote failure attached: the retry's error is the one that
        // matters (it is the attempt that could have reached the chain), but the
        // original explains WHY there was a retry at all, and it was previously
        // dropped entirely. Only set when nothing else owns `cause`. This cannot
        // mis-classify the row: `isApplyAfterSubmitError` walks the cause chain,
        // and an apply-after-submit original never reaches this retry (it is
        // excluded by the gate above).
        if (fallbackErr instanceof Error && fallbackErr.cause === undefined) {
          fallbackErr.cause = err;
        }
        throw fallbackErr;
      }
    }
    // Not retryable (local prove, already-submitted attempt, or an
    // apply-after-submit failure): the original error propagates unchanged.
    throw err;
  }
}

/**
 * `TransactionProver` exposes `serialize()` returning a descriptor like
 * `"local"` or `"remote|<endpoint>[|<timeout_ms>]"` (per the SDK's wasm-bindgen
 * docstring). Used to decide whether a given prover is the local one — in
 * which case we route the prove step through the offscreen document for
 * multi-threading — vs. a remote one — which stays on the SDK's bundled
 * path since it's just an RPC.
 */
function isLocalProver(prover: TransactionProver): boolean {
  try {
    return (prover as unknown as { serialize: () => string }).serialize() === 'local';
  } catch {
    return false;
  }
}

/**
 * Build the `(accountId, request)` tuple for a send transaction's execute
 * step, used by both the actual `sendTransaction` flow and the speculation
 * flow. Keeping this in a single function is what makes the two agree on the
 * request they build from a given set of params.
 *
 * The two requests are NOT byte-identical — the note's serial number is random,
 * so no two builds of the same send ever match. The cache doesn't need them to:
 * `speculationParamsHash` keys purely on the params, and a hit replays the
 * cached execution + proof wholesale rather than rebuilding a request.
 *
 * Note: a fresh `AccountId` is allocated for the subsequent `executeTransaction`
 * rather than sharing one. As of SDK 0.15.9 neither `executeTransaction` nor the
 * note builders consume their `AccountId` by value (the generated glue reads
 * `__wbg_ptr` without `__destroy_into_raw`), so this is belt-and-braces — but
 * re-check the glue before relying on sharing, since a method that DOES move its
 * argument leaves the JS handle nulled.
 */
async function buildSendExecuteArgs(
  wasm: any,
  inner: any,
  senderAccountId: string,
  recipientAccountId: string,
  faucetId: string,
  noteType: NoteType | string,
  amount: string | bigint,
  reclaimAfter: number | undefined
): Promise<{ accountId: any; request: TransactionRequest }> {
  const senderId = resolveAccountId(wasm, senderAccountId);
  const receiverId = resolveAccountId(wasm, recipientAccountId);
  // noteType arrives as either an SDK enum (real send) or a literal
  // 'public'/'private' string (speculation) — `isPrivateNoteType` takes both and
  // throws on anything else rather than silently downgrading to public. The
  // enum is numeric (`Private = 0`), so the former `typeof === 'object'` arm
  // never matched and every non-'private' value fell through to public.
  const nt = isPrivateNoteType(noteType) ? wasm.NoteType.Private : wasm.NoteType.Public;
  // The sender's local account supplies the outgoing asset's vault key
  // (callback flag included) — see `buildSendTransactionRequest`.
  const senderAccount = await inner.getAccount(resolveAccountId(wasm, senderAccountId));
  const request = buildSendTransactionRequest(
    senderAccount ?? undefined,
    senderId,
    receiverId,
    faucetId,
    typeof amount === 'string' ? BigInt(amount) : amount,
    nt,
    reclaimAfter
  );
  const senderIdForExec = resolveAccountId(wasm, senderAccountId);
  return { accountId: senderIdForExec, request };
}

/**
 * Hash speculation params into a stable string. MUST stay in sync with
 * the hashParams impl inside SpeculationManager — both sides need the
 * same key for cache-hit detection.
 */
function speculationParamsHash(p: SpeculationParams): string {
  return [p.accountId, p.recipientAccountId, p.faucetId, p.noteType, p.amount.toString()].join('|');
}

/**
 * Mirror of the SDK's `resolveAccountRef` (js/utils.js) — converts a string
 * account identifier (hex or bech32) into the wasm-bindgen `AccountId` type
 * that lower-level methods like `executeTransaction` and `getAccount` take.
 * The wallet stores account IDs as bech32 (`mtst1...` for testnet), but in
 * places (URL params, dApp inputs) a `0x`-prefixed hex form may also appear,
 * so handle both.
 *
 * The composite `WalletAccount.publicKey` form (`<address>_<suffix>`) is reduced
 * to its address first, exactly as `walletAccountIdToSdk` does for the SW-side
 * path — every caller here passes an ACCOUNT id, and `Address.fromBech32` only
 * parses the composite form for suffixes whose routing parameters happen to
 * decode. Ids without a `_` are unaffected. This matters most for the sender
 * account read (`getAccount`): without the split, a composite id could throw
 * where nothing read the account at all before.
 *
 * Note: each call returns a freshly-allocated `AccountId`. As of SDK 0.15.9 the
 * methods used here borrow rather than move it, but some wasm-bindgen methods do
 * move their argument (`exportAccountFile` is one) and leave the JS handle
 * nulled, so allocating per call site keeps that distinction from mattering.
 */
function resolveAccountId(wasm: any, ref: string): any {
  const address = ref.split('_')[0] ?? ref;
  if (address.startsWith('0x') || address.startsWith('0X')) {
    // Lowercase the prefix for the same reason `accountRefToSdk` does: the hex
    // DIGITS are case-insensitive but `fromHex` requires a literal '0x' and
    // throws on '0X…', so the uppercase arm led straight to a guaranteed throw.
    return wasm.AccountId.fromHex(`0x${address.slice(2)}`);
  }
  return wasm.AccountId.fromBech32(address);
}
