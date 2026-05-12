import {
  Account,
  AccountFile,
  AuthSecretKey,
  exportStore,
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
import { Buffer } from 'buffer';

import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { clearConnectivityIssue, markConnectivityIssue } from 'lib/miden/activity/connectivity-state';
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
import { ConsumeTransaction, SendTransaction } from '../db/types';
// Guardian helpers are dynamic-imported inside the methods that use them to avoid
// a module init cycle: miden-client-interface → guardian/index → sdk/miden-client →
// miden-client-interface. Static imports here deadlock init_guardian_manager in the
// SW bundle (both sides' __esmMin wrappers await each other).
import type { CreatedGuardianKeys } from '../guardian/account';

export interface GuardianAccountCreationResult {
  accountId: string;
  keys: CreatedGuardianKeys;
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

  /**
   * Create a 3-key Guardian account. Returns the account ID alongside the hot
   * ciphertext + cold secret-key bytes the wallet must persist (vault wraps
   * both before writing them to storage).
   */
  async createGuardianMidenWallet(coldSeed?: Uint8Array): Promise<GuardianAccountCreationResult> {
    const { createGuardianAccount } = await import('../guardian/account');
    const { account, keys } = await createGuardianAccount(this.client, coldSeed);
    return { accountId: getBech32AddressFromAccountId(account.id()), keys };
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

  async importAccountBySeed(seed: Uint8Array): Promise<string> {
    return await this.importPublicMidenWalletFromSeed(seed);
  }

  /**
   * Discover and adopt all Guardian accounts authorized by the cold keys
   * derived from `mnemonic` against `guardianEndpoint`. Iterates HD indices
   * 0..MAX-1 and stops at the first miss (no accounts returned for that
   * cold commitment).
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

    for (let hdIndex = 0; hdIndex < MAX_RECOVERY_HD_INDEX; hdIndex++) {
      const coldSeed = deriveColdSeed(hdIndex);
      const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
      const coldPublicKey = Buffer.from(coldSk.publicKey().serialize().slice(1)).toString('hex');
      const coldSecretKeyHex = Buffer.from(coldSk.serialize()).toString('hex');

      const lookupClient = new MultisigClient(this.client, { guardianEndpoint });
      const lookupSigner = new EcdsaSigner(coldSk);
      const matches = await lookupClient.recoverByKey(lookupSigner);

      if (matches.length === 0) {
        // First miss — assume no further accounts under this seed at this endpoint.
        break;
      }

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
      const { result } = await this.client.transactions.submit(accountId, transactionRequest, { prover });
      return result;
    }, delegateTransaction);
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
