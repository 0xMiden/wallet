import {
  Account,
  AccountFile,
  exportStore,
  getWasmOrThrow,
  importStore,
  InputNoteRecord,
  InputNoteState,
  MidenClient,
  Note,
  NoteExportFormat,
  NoteFile,
  NoteQuery,
  NoteType,
  TransactionProver,
  TransactionRequest,
  TransactionResult
} from '@miden-sdk/miden-sdk/lazy';

import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearConnectivityIssue, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
import { isOffscreenAvailable, proveViaOffscreen } from 'lib/miden/back/offscreen-prover';
import {
  DEFAULT_NETWORK,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS,
  getNoteTransportUrl
} from 'lib/miden-chain/constants';
import { isMobile } from 'lib/platform';
import { WalletType } from 'screens/onboarding/types';

import { NoteExportType } from './constants';
import { getBech32AddressFromAccountId } from './helpers';
import { yieldWasmClientLock } from './miden-client';
import { ConsumeTransaction, SendTransaction } from '../db/types';

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
};

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

export class MidenClientInterface {
  client: MidenClient;
  network: string;

  private constructor(client: MidenClient, network: string) {
    this.client = client;
    this.network = network;
  }

  static async create(options: MidenClientCreateOptions = {}) {
    const network = DEFAULT_NETWORK;

    if (process.env.MIDEN_USE_MOCK_CLIENT === 'true') {
      const sdk = await import('@miden-sdk/miden-sdk/lazy');
      const mockClient = await sdk.MidenClient.createMock({ seed: options.seed });
      return new MidenClientInterface(mockClient, 'mock');
    }

    const hasKeystore = !!(options.getKeyCallback || options.insertKeyCallback || options.signCallback);

    const midenClient = await MidenClient.create({
      rpcUrl: MIDEN_NETWORK_ENDPOINTS.get(network)!,
      noteTransportUrl: getNoteTransportUrl(network),
      seed: options.seed,
      keystore: hasKeystore
        ? {
            getKey: options.getKeyCallback!,
            insertKey: options.insertKeyCallback!,
            sign: options.signCallback!
          }
        : undefined,
      proverUrl: MIDEN_PROVING_ENDPOINTS.get(network)
    });

    return new MidenClientInterface(midenClient, network);
  }

  static fromClient(client: MidenClient, network: string) {
    return new MidenClientInterface(client, network);
  }

  free() {
    this.client.terminate();
  }

  async createMidenWallet(walletType: WalletType, seed?: Uint8Array): Promise<string> {
    const isPublic = walletType === WalletType.OnChain;
    const wallet: Account = await this.client.accounts.create({
      storage: isPublic ? 'public' : 'private',
      seed
    });
    return getBech32AddressFromAccountId(wallet.id());
  }

  async importMidenWallet(accountBytes: Uint8Array): Promise<string> {
    const accountFile = AccountFile.deserialize(accountBytes);
    const wallet: Account = await this.client.accounts.import({ file: accountFile });
    return getBech32AddressFromAccountId(wallet.id());
  }

  async importPublicMidenWalletFromSeed(seed: Uint8Array) {
    const account = await this.client.accounts.import({ seed });
    return getBech32AddressFromAccountId(account.id());
  }

  async importNoteBytes(noteBytes: Uint8Array) {
    const noteFile = NoteFile.deserialize(noteBytes);
    return await this.client.notes.import(noteFile);
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
    return allInputNotes.map(note => {
      const assets = note
        .details()
        .assets()
        .fungibleAssets()
        .map(asset => ({
          amount: asset.amount().toString(),
          faucetId: getBech32AddressFromAccountId(asset.faucetId())
        }));
      const noteMet = note.metadata();
      return {
        noteId: note.id().toString(),
        noteType: noteMet?.noteType(),
        senderAccountId: noteMet ? getBech32AddressFromAccountId(noteMet.sender()) : undefined,
        nullifier: note.nullifier(),
        state: note.state(),
        assets
      };
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

  async getConsumableNotes(accountId: string): Promise<InputNoteRecord[]> {
    return await this.client.notes.listAvailable({ account: accountId });
  }

  async sendTransaction(dbTransaction: SendTransaction): Promise<TransactionResult> {
    const { accountId, secondaryAccountId, faucetId, noteType, amount, extraInputs } = dbTransaction;

    let reclaimAfter: number | undefined;
    if (extraInputs?.recallBlocks) {
      const syncResult = await this.client.sync();
      reclaimAfter = syncResult.blockNum() + extraInputs.recallBlocks;
    }

    return this.withProverFallback(async prover => {
      if (this.shouldUseOffscreenProver(prover)) {
        return await this.proveLocallyViaOffscreen(async (wasm, inner) => {
          const senderId = resolveAccountId(wasm, accountId);
          const receiverId = resolveAccountId(wasm, secondaryAccountId);
          const tokenId = resolveAccountId(wasm, faucetId);
          const nt = noteType === 'private' ? wasm.NoteType.Private : wasm.NoteType.Public;
          const request: TransactionRequest = await inner.newSendTransactionRequest(
            senderId,
            receiverId,
            tokenId,
            nt,
            BigInt(amount),
            reclaimAfter ?? null,
            null
          );
          // newSendTransactionRequest consumed senderId by value; allocate
          // a fresh AccountId for executeTransaction (also by-value).
          const senderIdForExec = resolveAccountId(wasm, accountId);
          return { accountId: senderIdForExec, request };
        });
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

  async consumeNoteId(transaction: ConsumeTransaction): Promise<TransactionResult> {
    const { accountId, noteId } = transaction;

    return this.withProverFallback(async prover => {
      if (this.shouldUseOffscreenProver(prover)) {
        return await this.proveLocallyViaOffscreen(async (wasm, inner) => {
          // The bundled `transactions.consume` accepts string note IDs and
          // internally calls `getInputNote` to resolve to Note objects.
          // We do that ourselves via the proxied inner. `getInputNote`
          // returns an InputNoteRecord; the WASM `newConsumeTransactionRequest`
          // takes Note[] (via the wasm.NoteArray helper).
          const inputNoteRecord = await inner.getInputNote(noteId);
          if (!inputNoteRecord) {
            throw new Error(`Note ${noteId} not found in store`);
          }
          // InputNoteRecord exposes `.note()` returning the underlying
          // Note. Stock SDK's TransactionsResource does the same thing.
          const note: Note = inputNoteRecord.note();
          const noteArray = new wasm.NoteArray();
          noteArray.push(note);
          const request: TransactionRequest = await inner.newConsumeTransactionRequest(noteArray);
          const acctId = resolveAccountId(wasm, accountId);
          return { accountId: acctId, request };
        });
      }
      const { result } = await this.client.transactions.consume({
        account: accountId,
        notes: [noteId],
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

    return this.withProverFallback(async prover => {
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
    buildExecuteArgs: (wasm: any, inner: any) => Promise<{ accountId: any; request: TransactionRequest }>
  ): Promise<TransactionResult> {
    try {
      const wasm = await getWasmOrThrow();
      const innerGetter = (this.client as unknown as { _getInnerWebClient?: () => any })._getInnerWebClient;
      if (typeof innerGetter !== 'function') {
        throw new Error('_getInnerWebClient missing on linked SDK — rebuild + reinstall @miden-sdk/miden-sdk.');
      }
      const inner = innerGetter.call(this.client);
      const { accountId, request } = await buildExecuteArgs(wasm, inner);
      const txResult: TransactionResult = await inner.executeTransaction(accountId, request);
      const txResultBytes = txResult.serialize();
      // Yield the SW's WASM lock during the offscreen prove (~10s), since
      // the offscreen doc has its own WASM instance and we're not touching
      // the SW client. Reacquired automatically before submit + apply.
      const { provenBytes, durationMs } = await yieldWasmClientLock(() => proveViaOffscreen(txResultBytes, null));
      const proven = wasm.ProvenTransaction.deserialize(new Uint8Array(provenBytes));
      const height = await inner.submitProvenTransaction(proven, txResult);
      await inner.applyTransaction(txResult, height);
      console.log(`[mt-offscreen-prove] tx_completed prove_ms=${durationMs.toFixed(0)}`);
      return txResult;
    } catch (err) {
      console.error('[mt-offscreen-prove] FAILED', err);
      throw err;
    }
  }

  async exportDb() {
    const storeName = this.client.storeIdentifier();
    return await exportStore(storeName);
  }

  async importDb(dump: string) {
    const storeName = this.client.storeIdentifier();
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

  private async withProverFallback<T>(
    fn: (prover?: TransactionProver) => Promise<T>,
    delegateTransaction?: boolean
  ): Promise<T> {
    // On mobile, always delegate and never fallback to local
    const shouldDelegate = isMobile() ? true : delegateTransaction;

    try {
      const result = !shouldDelegate ? await fn(TransactionProver.newLocalProver()) : await fn(); // uses MidenClient's defaultProver (remote)
      // A successful prover call (whether local or remote) means the prover
      // pathway the wallet actually uses is healthy. If we'd previously
      // marked the prover as down, clear it now — the old design never
      // cleared and the banner pinned forever after a single transient 502.
      clearConnectivityIssue('prover');
      return result;
    } catch (err) {
      if (shouldDelegate) {
        // The remote prover path failed. Whether or not we can fall back
        // locally (we can't on mobile), the user-facing surface should know
        // remote proving is unavailable. Only categorize transport-shaped
        // errors so we don't trip the banner on semantic WASM errors
        // (e.g. "note has already been consumed").
        if (isLikelyNetworkError(err)) {
          markConnectivityIssue('prover');
        }
        if (!isMobile()) {
          // Desktop: silently fall back to local proving.
          return await fn(TransactionProver.newLocalProver());
        }
      }
      throw err;
    }
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
