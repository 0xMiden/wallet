import {
  Account,
  AccountFile,
  AuthSecretKey,
  type ConsumableNoteRecord,
  exportStore,
  getWasmOrThrow,
  importStore,
  InputNoteRecord,
  InputNoteState,
  MidenClient,
  Note,
  NoteDetails,
  NoteExportFormat,
  NoteFile,
  NoteQuery,
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
import { isMobile } from 'lib/platform';
import type { AuthScheme } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { NoteExportType } from './constants';
import { type ConsumableNoteDto, reduceConsumableNoteRecords } from './consumable-notes';
import { getBech32AddressFromAccountId } from './helpers';
import { yieldWasmClientLock } from './miden-client';
import { buildNativeProverCallback } from './native-prover-mobile';
import { ConsumeTransaction, SendTransaction, SwapTransaction } from '../db/types';
// Guardian helpers are dynamic-imported inside the methods that use them to avoid
// a module init cycle: miden-client-interface → guardian/index → sdk/miden-client →
// miden-client-interface. Static imports here deadlock init_guardian_manager in the
// SW bundle (both sides' __esmMin wrappers await each other).
// guardian/native-http is cycle-safe (it only pulls constants + platform).
import type { CreatedGuardianKeys } from '../guardian/account';
import { registerGuardianOrigin } from '../guardian/native-http';

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
 * The wrapped `NoteDetails` variant carries no tag (`tag: None`,
 * `after_block_num: 0`), so the imported note is stored as `Expected` without
 * tag-based sync tracking. It still becomes consumable: the client's
 * `reconcile_expected_notes` fetches every expected note by ID on each
 * `syncState`, recovering the on-chain metadata and inclusion proof and
 * transitioning it to `Committed`. So dropping the metadata here is safe.
 */
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
    return NoteFile.fromNoteDetails(new NoteDetails(note.assets(), note.recipient()));
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
            sign: options.signCallback!
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
    this.client.terminate();
  }

  async createMidenWallet(walletType: WalletType, seed?: Uint8Array, auth?: AuthScheme): Promise<string> {
    if (walletType === WalletType.Guardian) {
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
  async createGuardianMidenWallet(coldSeed?: Uint8Array): Promise<GuardianAccountCreationResult> {
    const { createGuardianAccount } = await import('../guardian/account');
    const { account, keys, guardianEndpoint } = await createGuardianAccount(this.client, coldSeed);
    return { accountId: getBech32AddressFromAccountId(account.id()), keys, guardianEndpoint };
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
          await this.client.accounts.insert({ account: acc, overwrite: true });
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
   * `deserializeNoteFileOrNote` wraps raw `Note` bytes via
   * `NoteFile.fromNoteDetails`, so for that path the returned hex is a
   * details commitment, not a note ID.
   */
  async importNoteBytes(noteBytes: Uint8Array): Promise<string> {
    const noteFile = deserializeNoteFileOrNote(noteBytes);
    // String(...) tolerates both return shapes across the 0.15 alpha line:
    // alpha.4 resolves a NoteId object, current `next` resolves the hex
    // string directly.
    return String(await this.client.notes.import(noteFile));
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
    await this.client.notes.sendPrivate({ note, to });
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
    return reduceConsumableNoteRecords(records);
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
    if (this.network === 'mock') {
      return await this.client.notes.listAvailable({ account: accountId });
    }
    const wasm = await getWasmOrThrow();
    const syncHeight = await this.client.getSyncHeight();
    const inner = await WasmWebClient.createClient(getEffectiveRpcUrl());
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

  async sendTransaction(dbTransaction: SendTransaction): Promise<TransactionResult> {
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

    return proveWithFallback(async prover => {
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
                noteType: noteType === 'private' ? 'private' : 'public',
                amount: BigInt(amount)
              }
            : undefined;
        return await this.proveLocallyViaOffscreen(
          (wasm, inner) =>
            buildSendExecuteArgs(wasm, inner, accountId, secondaryAccountId, faucetId, noteType, amount, reclaimAfter),
          cacheParams
        );
      }
      const { result } = await this.client.transactions.send({
        account: accountId,
        to: secondaryAccountId,
        token: faucetId,
        amount,
        type: noteType as any,
        reclaimAfter,
        prover
      });
      return result;
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
    const { provenBytes, durationMs } = await yieldWasmClientLock(() =>
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
    return proveWithFallback(async prover => {
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
        });
      }
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

    const offer = { token: faucetId, amount };
    const request = { token: extraInputs.requestedFaucetId, amount: extraInputs.requestedAmount };

    return proveWithFallback(async prover => {
      const { result } = await this.client.transactions.pswapCreate({
        account: accountId,
        offer,
        request,
        prover
      });
      return result;
    }, transaction.delegateTransaction);
  }

  async newTransaction(
    accountId: string,
    requestBytes: Uint8Array,
    delegateTransaction?: boolean
  ): Promise<TransactionResult> {
    const transactionRequest = TransactionRequest.deserialize(requestBytes);

    return proveWithFallback(async prover => {
      if (this.shouldUseOffscreenProver(prover)) {
        return await this.proveLocallyViaOffscreen(async wasm => {
          // `inner.executeTransaction` consumes both args by value. We get a
          // fresh deserialization of the same bytes so we don't share a
          // moved-from TransactionRequest with anything outside this scope.
          const request = TransactionRequest.deserialize(requestBytes);
          const acctId = resolveAccountId(wasm, accountId);
          return { accountId: acctId, request };
        });
      }
      const { result } = await this.client.transactions.submit(accountId, transactionRequest, { prover });
      return result;
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
    cacheParams?: SpeculationParams
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
          await yieldWasmClientLock(() => mgr.awaitMatching(cacheParams));
          hit = mgr.consumeCacheHit(cacheParams);
          console.log(
            `[mt-offscreen-prove] awaited in-flight speculation ${(performance.now() - tWait).toFixed(0)}ms hit=${!!hit}`
          );
        }
        if (hit) {
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
      const { provenBytes, durationMs } = await yieldWasmClientLock(() => proveViaOffscreen(txResultBytes, null));
      recordProveTiming(
        `proveLocallyViaOffscreen proveViaOffscreen returned in ${durationMs.toFixed(0)}ms (lock reacquired); submitting + applying`
      );
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

  async waitForTransactionCommit(
    transactionId: string,
    maxWaitMs: number = 60_000,
    delayMs: number = 5_000
  ): Promise<void> {
    await this.client.transactions.waitFor(transactionId, { timeout: maxWaitMs, interval: delayMs });
  }
}

/**
 * Select the prover and run `fn(prover)` for a transaction. Shared by EVERY
 * wallet transaction path (guardian and non-guardian) so proving behaves
 * identically everywhere:
 *  - delegate (setting on) → `fn()` with no explicit prover, so the caller
 *    proves via its remote prover; on failure, fall back to the local/native
 *    prover below.
 *  - otherwise → `fn(localProver)`, where localProver is the native Rust prover
 *    on mobile (off the main thread via @miden/native-prover) and the WASM local
 *    prover on desktop/extension.
 *
 * On mobile we must NEVER prove with WASM on the main thread — it freezes the UI
 * for the whole multi-second prove. Callers driving the raw inner WebClient
 * directly (the guardian pipeline) must pass an explicit remote prover in the
 * delegate branch, since the raw client's default prover is the main-thread WASM
 * one; see `generateGuardianTransaction`.
 */
export async function proveWithFallback<T>(
  fn: (prover?: TransactionProver) => Promise<T>,
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

  try {
    const t0 = performance.now();
    const result = !shouldDelegate ? await fn(localProverFactory()) : await fn();
    const pathLabel = shouldDelegate ? 'delegate' : isMobile() ? 'native-mobile' : 'local';
    const durationMs = (performance.now() - t0).toFixed(1);
    recordProveTiming(`path=${pathLabel} duration_ms=${durationMs} platform=${isMobile() ? 'mobile' : 'desktop'}`);
    // A successful prover call (whether local or remote) means the prover
    // pathway the wallet actually uses is healthy. If we'd previously
    // marked the prover as down, clear it now — the old design never
    // cleared and the banner pinned forever after a single transient 502.
    clearConnectivityIssue('prover');
    return result;
  } catch (err) {
    if (shouldDelegate) {
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
      const t0 = performance.now();
      const result = await fn(localProverFactory());
      recordProveTiming(
        `path=${isMobile() ? 'native-mobile-fallback' : 'local-fallback'} duration_ms=${(
          performance.now() - t0
        ).toFixed(1)}`
      );
      return result;
    }
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
 * step, used by both the actual `sendTransaction` flow and the
 * speculation flow. Keeping this in a single function means the
 * Speculation params and the real-send params produce IDENTICAL
 * TransactionRequest WASM objects, which is what the cache hit relies on.
 *
 * Note: WASM-bindgen value-consumption is real here. `newSendTransactionRequest`
 * consumes `senderId` by value; we allocate a fresh `AccountId` for the
 * subsequent `executeTransaction`. Don't refactor this to share AccountIds
 * across calls without re-checking the wasm-bindgen ownership semantics.
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
  const tokenId = resolveAccountId(wasm, faucetId);
  // noteType arrives as either an SDK enum (real send) or a literal
  // 'public'/'private' string (speculation). Handle both.
  const isPrivate = noteType === 'private' || (typeof noteType === 'object' && noteType === wasm.NoteType.Private);
  const nt = isPrivate ? wasm.NoteType.Private : wasm.NoteType.Public;
  const request: TransactionRequest = await inner.newSendTransactionRequest(
    senderId,
    receiverId,
    tokenId,
    nt,
    typeof amount === 'string' ? BigInt(amount) : amount,
    reclaimAfter ?? null,
    null
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
 * that lower-level methods like `executeTransaction` and
 * `newSendTransactionRequest` consume. The wallet stores account IDs as
 * bech32 (`mtst1...` for testnet), but in places (URL params, dApp inputs)
 * a `0x`-prefixed hex form may also appear, so handle both.
 *
 * Note: each call returns a freshly-allocated `AccountId`. Multiple
 * wasm-bindgen WASM methods CONSUME their `AccountId` argument
 * (e.g. `newSendTransactionRequest` and `executeTransaction` both move
 * the value), so callers must allocate one per consume site.
 */
function resolveAccountId(wasm: any, ref: string): any {
  if (ref.startsWith('0x') || ref.startsWith('0X')) {
    return wasm.AccountId.fromHex(ref);
  }
  return wasm.AccountId.fromBech32(ref);
}
