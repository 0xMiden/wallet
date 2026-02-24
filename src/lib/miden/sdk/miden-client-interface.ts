import {
  Account,
  AccountFile,
  AccountStorageMode,
  Address,
  ConsumableNoteRecord,
  InputNoteRecord,
  InputNoteState,
  Note,
  NoteFile,
  NoteFilter,
  NoteType,
  TransactionFilter,
  TransactionProver,
  TransactionRequest,
  TransactionResult,
  WebClient
} from '@miden-sdk/miden-sdk';

import {
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_NETWORK_NAME,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS
} from 'lib/miden-chain/constants';
import { isMobile } from 'lib/platform';
import { WalletType } from 'screens/onboarding/types';

import { ConsumeTransaction, SendTransaction } from '../db/types';
import { toNoteType } from '../helpers';
import { NoteExportType } from './constants';
import { accountIdStringToSdk, getBech32AddressFromAccountId } from './helpers';

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
  webClient: WebClient;
  network: string;
  onConnectivityIssue?: () => void;

  private constructor(webClient: WebClient, network: string, onConnectivityIssue?: () => void) {
    this.webClient = webClient;
    this.network = network;
    this.onConnectivityIssue = onConnectivityIssue;
  }

  /**
   * Do not use this method directly. Use getMidenClient instead.
   * Creates a new Miden client instance.
   * @param options - The options for creating the Miden client.
   * @returns The Miden client instance.
   * @note A new web worker is created for each invocation. Each worker must be manually disposed of.
   */
  static async create(options: MidenClientCreateOptions = {}) {
    const seed = options.seed;
    const network = MIDEN_NETWORK_NAME.TESTNET;
    // Keep note transport on testnet for now.

    // In test builds, swap to the SDK's mock client to avoid hitting the real chain.
    if (process.env.MIDEN_USE_MOCK_CLIENT === 'true') {
      const sdk = await import('@miden-sdk/miden-sdk');
      const mockWebClient = await sdk.MockWebClient.createClient(undefined, undefined, options.seed);
      return new MidenClientInterface(mockWebClient as unknown as WebClient, 'mock', options.onConnectivityIssue);
    }
    const webClient = await WebClient.createClientWithExternalKeystore(
      MIDEN_NETWORK_ENDPOINTS.get(network)!,
      MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network)!,
      seed,
      undefined,
      options.getKeyCallback,
      options.insertKeyCallback,
      options.signCallback
    );

    return new MidenClientInterface(webClient, network, options.onConnectivityIssue);
  }

  /**
   * Create a client wrapper around a provided WebClient instance.
   * Useful for tests that want to inject MockWebClient.
   */
  static fromWebClient(webClient: WebClient, network: string, onConnectivityIssue?: () => void) {
    return new MidenClientInterface(webClient, network, onConnectivityIssue);
  }

  free() {
    this.webClient.terminate();
  }

  async createMidenWallet(walletType: WalletType, seed?: Uint8Array): Promise<string> {
    // Create a new wallet
    const accountStorageMode =
      walletType === WalletType.OnChain ? AccountStorageMode.public() : AccountStorageMode.private();

    const wallet: Account = await this.webClient.newWallet(accountStorageMode, true, 0, seed);
    const walletId = getBech32AddressFromAccountId(wallet.id());

    return walletId;
  }

  async importMidenWallet(accountBytes: Uint8Array): Promise<string> {
    const accountFile = AccountFile.deserialize(accountBytes);
    const wallet: Account = await this.webClient.importAccountFile(accountFile);
    const walletIdString = getBech32AddressFromAccountId(wallet.id());

    return walletIdString;
  }

  async importPublicMidenWalletFromSeed(seed: Uint8Array) {
    const account = await this.webClient.importPublicAccountFromSeed(seed, true, 0);

    return getBech32AddressFromAccountId(account.id());
  }

  // TODO: is this method even used?
  async consumeTransaction(accountId: string, listOfNoteIds: string[], delegateTransaction?: boolean) {
    const notes = await this.getNotesByIds(listOfNoteIds);
    const consumeTransactionRequest = this.webClient.newConsumeTransactionRequest(notes);
    await this.executeProveAndSubmitTransactionWithFallback(accountId, consumeTransactionRequest, delegateTransaction);
  }

  async importNoteBytes(noteBytes: Uint8Array) {
    const noteFile = NoteFile.deserialize(noteBytes);
    const result = await this.webClient.importNoteFile(noteFile);
    return result;
  }

  async consumeNoteId(transaction: ConsumeTransaction): Promise<Uint8Array> {
    const { accountId, noteId } = transaction;

    const notes = await this.getNotesByIds([noteId]);
    const consumeTransactionRequest = this.webClient.newConsumeTransactionRequest(notes);
    let consumeTransactionResult = await this.webClient.executeTransaction(
      accountIdStringToSdk(accountId),
      consumeTransactionRequest
    );

    return consumeTransactionResult.serialize();
  }

  async getAccount(accountId: string) {
    const result = await this.webClient.getAccount(accountIdStringToSdk(accountId));
    return result;
  }

  async importAccountById(accountId: string) {
    const result = await this.webClient.importAccountById(accountIdStringToSdk(accountId));
    return result;
  }

  async getAccounts() {
    const result = await this.webClient.getAccounts();
    return result;
  }

  async getInputNotes(noteFilter: NoteFilter): Promise<InputNoteRecord[]> {
    const result = await this.webClient.getInputNotes(noteFilter);
    return result;
  }

  async getInputNoteDetails(noteFilter: NoteFilter): Promise<InputNoteDetails[]> {
    const allInputNotes = await this.webClient.getInputNotes(noteFilter);
    const details = allInputNotes.map(note => {
      const assets = note
        .details()
        .assets()
        .fungibleAssets()
        .map(asset => ({
          amount: asset.amount().toString(),
          faucetId: getBech32AddressFromAccountId(asset.faucetId())
        }));
      const noteMet = note.metadata();
      const details = {
        noteId: note.id().toString(),
        noteType: noteMet?.noteType(),
        senderAccountId: noteMet ? getBech32AddressFromAccountId(noteMet.sender()) : undefined,
        nullifier: note.nullifier(),
        state: note.state(),
        assets: assets
      };
      return details;
    });
    return details;
  }

  async syncState() {
    return await this.webClient.syncState();
  }

  async exportNote(noteId: string, exportType: NoteExportType): Promise<Uint8Array> {
    const result = await this.webClient.exportNoteFile(noteId, exportType);
    const byteArray = result.serialize();

    return byteArray;
  }

  async sendPrivateNote(note: Note, address: Address): Promise<void> {
    return await this.webClient.sendPrivateNote(note, address);
  }

  async getConsumableNotes(accountId: string): Promise<ConsumableNoteRecord[]> {
    const result = await this.webClient.getConsumableNotes(accountIdStringToSdk(accountId));

    return result;
  }

  async sendTransaction(dbTransaction: SendTransaction) {
    const {
      accountId: senderAccountId,
      secondaryAccountId: recipientAccountId,
      faucetId,
      noteType,
      amount,
      extraInputs: { recallBlocks }
    } = dbTransaction;

    let recallHeight = undefined;
    if (recallBlocks) {
      const syncState = await this.syncState();
      const blockNum = syncState.blockNum();
      recallHeight = blockNum + recallBlocks;
    }

    let sendTransactionRequest = this.webClient.newSendTransactionRequest(
      accountIdStringToSdk(senderAccountId),
      accountIdStringToSdk(recipientAccountId),
      accountIdStringToSdk(faucetId),
      toNoteType(noteType),
      amount,
      recallHeight
    );
    let sendTransactionResult = await this.webClient.executeTransaction(
      accountIdStringToSdk(senderAccountId),
      sendTransactionRequest
    );

    return sendTransactionResult.serialize();
  }

  async exportDb() {
    const dump = await this.webClient.exportStore();
    return dump;
  }

  async importDb(dump: any) {
    await this.webClient.forceImportStore(dump, this.network);
  }

  private async getNotesByIds(noteIds: string[]): Promise<Note[]> {
    const notes: Note[] = [];
    for (const noteId of noteIds) {
      const record = await this.webClient.getInputNote(noteId);
      if (!record) {
        throw new Error(`Input note not found: ${noteId}`);
      }
      notes.push(record.toNote());
    }
    return notes;
  }

  async newTransaction(accountId: string, requestBytes: Uint8Array) {
    const transactionRequest = TransactionRequest.deserialize(requestBytes);
    const transactionResult = await this.webClient.executeTransaction(
      accountIdStringToSdk(accountId),
      transactionRequest
    );
    return transactionResult.serialize();
  }

  async submitTransaction(
    transactionResultBytes: Uint8Array,
    delegateTransaction?: boolean,
    skipSync?: boolean
  ): Promise<TransactionResult> {
    // Skip sync on mobile to reduce memory pressure - AutoSync handles this
    if (!skipSync) {
      await this.syncState();
    }
    const transactionResult = TransactionResult.deserialize(transactionResultBytes);
    await this.proveAndSubmitTransactionWithFallback(transactionResult, delegateTransaction);
    return transactionResult;
  }

  async getTransactionsForAccount(accountId: string) {
    const transactions = await this.webClient.getTransactions(TransactionFilter.all());
    return transactions.filter(tx => getBech32AddressFromAccountId(tx.accountId()) === accountId);
  }

  async waitForTransactionCommit(
    transactionId: string,
    maxWaitMs: number = 10_000,
    delayMs: number = 1_000
  ): Promise<void> {
    let waited = 0;
    while (waited < maxWaitMs) {
      await this.syncState();
      const uncommitted = await this.webClient.getTransactions(TransactionFilter.uncommitted());
      const stillPending = uncommitted.some(tx => tx.id().toHex() === transactionId);
      if (!stillPending) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      waited += delayMs;
    }
    throw new Error('Timeout waiting for transaction commit');
  }

  private async proveAndSubmitTransactionWithFallback(
    transactionResult: TransactionResult,
    delegateTransaction?: boolean
  ) {
    try {
      await this.proveAndSubmitTransaction(transactionResult, delegateTransaction);
    } catch (error) {
      // On mobile, never fall back to local prover (too resource-intensive)
      if (delegateTransaction && !isMobile()) {
        this.onConnectivityIssue?.();
        // Fallback to local prover - if this throws, error propagates to caller
        await this.proveAndSubmitTransaction(transactionResult, false);
      } else {
        // Not using delegation or on mobile, propagate the error
        throw error;
      }
    }
  }

  private async proveAndSubmitTransaction(transactionResult: TransactionResult, delegateTransaction?: boolean) {
    const transactionProver = delegateTransaction
      ? TransactionProver.newRemoteProver(MIDEN_PROVING_ENDPOINTS.get(this.network)!)
      : TransactionProver.newLocalProver();
    const provenTransaction = await this.webClient.proveTransaction(transactionResult, transactionProver);
    const submissionHeight = await this.webClient.submitProvenTransaction(provenTransaction, transactionResult);
    await this.webClient.applyTransaction(transactionResult, submissionHeight);
  }

  private async executeProveAndSubmitTransactionWithFallback(
    accountId: string,
    transactionRequest: TransactionRequest,
    delegateTransaction?: boolean
  ) {
    if (delegateTransaction) {
      try {
        // TODO: how to get transaction result here?
        await this.webClient.submitNewTransaction(accountIdStringToSdk(accountId), transactionRequest);
      } catch (error) {
        this.onConnectivityIssue?.();
        await this.executeProveAndSubmitTransactionLocal(accountId, transactionRequest);
      }
    } else {
      await this.executeProveAndSubmitTransactionLocal(accountId, transactionRequest);
    }
  }

  private async executeProveAndSubmitTransactionLocal(accountId: string, transactionRequest: TransactionRequest) {
    const wasmAccountId = accountIdStringToSdk(accountId);
    const transactionResult = await this.webClient.executeTransaction(wasmAccountId, transactionRequest);
    const provenTransaction = await this.webClient.proveTransaction(
      transactionResult,
      TransactionProver.newLocalProver()
    );
    const submissionHeight = await this.webClient.submitProvenTransaction(provenTransaction, transactionResult);
    await this.webClient.applyTransaction(transactionResult, submissionHeight);
  }
}
