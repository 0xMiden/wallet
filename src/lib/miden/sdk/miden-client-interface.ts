import {
  Account,
  AccountFile,
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
} from '@miden-sdk/miden-sdk';

import {
  DEFAULT_NETWORK,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS
} from 'lib/miden-chain/constants';
import { addConnectivityIssue } from 'lib/miden/activity/connectivity-issues';
import { isMobile } from 'lib/platform';
import { WalletType } from 'screens/onboarding/types';

import { ConsumeTransaction, SendTransaction } from '../db/types';
import { NoteExportType } from './constants';
import { getBech32AddressFromAccountId } from './helpers';
import { callGetKey, callInsertKey, callSign } from './keystore-bridge';

/**
 * Reduced from the historical 6-field shape (insertKey/getKey/sign/
 * onConnectivityIssue closures + seed) to just `seed` for the mock-client
 * test path. Production keystore wiring is now permanent: the bridge in
 * `keystore-bridge.ts` provides the callbacks at MidenClient.create time;
 * the wiring layer in `keystore-wiring.ts` re-points them on vault
 * unlock/lock.
 */
export type MidenClientCreateOptions = {
  seed?: Uint8Array;
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
      const sdk = await import('@miden-sdk/miden-sdk');
      const mockClient = await sdk.MidenClient.createMock({ seed: options.seed });
      return new MidenClientInterface(mockClient, 'mock');
    }

    // Permanent keystore wiring via the bridge. Late-binding: the
    // bridge's slots are populated by keystore-wiring.ts on Effector
    // unlocked/locked events. callSign throws if no active sign session;
    // callInsertKey throws if vault is locked.
    const midenClient = await MidenClient.create({
      rpcUrl: MIDEN_NETWORK_ENDPOINTS.get(network)!,
      noteTransportUrl: MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network),
      keystore: {
        getKey: callGetKey,
        insertKey: callInsertKey,
        sign: callSign
      },
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

  /**
   * Resolves once any in-flight serialized WASM call on the underlying
   * client has settled. Wallet-side code uses this to coordinate
   * non-WASM state changes (e.g. clearing the in-memory auth key on
   * lock) with the SDK's transaction execution pipeline — preventing
   * races where the kernel's auth callback fires after the key is
   * gone. See `Actions.lock` for the canonical use case.
   */
  async waitForIdle(): Promise<void> {
    await this.client.waitForIdle();
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
      if (!shouldDelegate) {
        return await fn(TransactionProver.newLocalProver());
      }
      // Build a fresh remote prover per-call instead of relying on the
      // client's defaultProver. The default prover is bound once at
      // MidenClient.create time and silently falls back to local proving
      // after a single network failure — never recovering for the lifetime
      // of the long-lived singleton. Explicit construction ensures every
      // transaction attempt gets a clean remote connection.
      const proverUrl = MIDEN_PROVING_ENDPOINTS.get(this.network);
      if (proverUrl) {
        return await fn(TransactionProver.newRemoteProver(proverUrl));
      }
      return await fn();
    } catch (err) {
      // Fallback to local prover on desktop only
      if (shouldDelegate && !isMobile()) {
        addConnectivityIssue();
        return await fn(TransactionProver.newLocalProver());
      }
      throw err;
    }
  }
}
