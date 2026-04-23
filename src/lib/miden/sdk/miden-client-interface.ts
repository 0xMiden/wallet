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
} from '@miden-sdk/miden-sdk/lazy';

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
// PSM helpers are dynamic-imported inside the methods that use them to avoid
// a module init cycle: miden-client-interface → psm/index → sdk/miden-client →
// miden-client-interface. Static imports here deadlock init_psm_manager in the
// SW bundle (both sides' __esmMin wrappers await each other).
import type { SignWordFunction } from '../psm/signer';
import { NoteExportType } from './constants';
import { getBech32AddressFromAccountId } from './helpers';

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
      noteTransportUrl: MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network),
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
    if (walletType === WalletType.Psm) {
      const { createPsmAccount } = await import('../psm/account');
      const account = await createPsmAccount(this.client, seed);
      return getBech32AddressFromAccountId(account.id());
    }

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

  async importAccountBySeed(
    walletType: WalletType,
    seed: Uint8Array,
    signWordFn: SignWordFunction,
    getPublicKeyForCommitment: (commitment: string) => Promise<string>
  ): Promise<string> {
    if (walletType === WalletType.Psm) {
      console.log('Importing PSM account from seed', seed);
      try {
        const [{ createPsmAccount, getSignerDetailsFromAccount }, { MultisigService }, { DEFAULT_PSM_ENDPOINT }] =
          await Promise.all([import('../psm/account'), import('../psm/index'), import('lib/miden-chain/constants')]);
        // Derive the account ID against the default guardian so it matches the ID
        // the account had at creation time. The user's custom guardian URL (persisted
        // in PSM_URL_STORAGE_KEY) is picked up later by importAccountFromPsm for the
        // live state fetch.
        const account = await createPsmAccount(this.client, seed, true, DEFAULT_PSM_ENDPOINT);
        console.log('[MidenClientInterface] Imported PSM account from seed with ID:', account.id().toString());
        const accountId = account.id().toString();
        const { commitment, publicKey } = await getSignerDetailsFromAccount(account, getPublicKeyForCommitment);
        await MultisigService.importAccountFromPsm(
          `0x${publicKey}`,
          `0x${commitment}`,
          signWordFn,
          accountId,
          this.client
        );
        return getBech32AddressFromAccountId(account.id());
      } catch (error) {
        console.log(error);
        throw new Error('Failed to import PSM account from seed');
      }
    }

    return await this.importPublicMidenWalletFromSeed(seed);
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
      return await fn(); // uses MidenClient's defaultProver (remote)
    } catch (err) {
      // Fallback to local prover on desktop only
      if (shouldDelegate && !isMobile()) {
        // Only mark a connectivity issue if the error actually looks network-related.
        // Semantic WASM-client errors (e.g. "note has already been consumed", "invalid
        // transaction request") are thrown before any prover RPC happens and must NOT
        // trip the connectivity banner — the network is fine, the request is just bad.
        if (isLikelyNetworkError(err)) {
          addConnectivityIssue();
        }
        return await fn(TransactionProver.newLocalProver());
      }
      throw err;
    }
  }
}

/**
 * Heuristic: does this error look like something a local-prover retry could plausibly
 * recover from? Keep the match deliberately conservative — false positives (marking a
 * semantic error as connectivity) are worse than false negatives (missing a real network
 * blip), because the banner persists until the user dismisses it.
 *
 * We match on: fetch/abort/timeout plumbing, HTTP 5xx wording, and tonic-web-wasm-client's
 * transport-layer error surface. We DO NOT match on "invalid transaction request" / "has
 * already been consumed" / other WASM-client validation messages that bubble up from
 * `execute_transaction` before any RPC is attempted.
 */
function isLikelyNetworkError(err: unknown): boolean {
  const message = (err as { message?: string } | null | undefined)?.message ?? String(err ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('invalid transaction request')) return false;
  if (lower.includes('has already been consumed')) return false;
  if (lower.includes('failed to fetch')) return true;
  if (lower.includes('networkerror')) return true;
  if (lower.includes('network error')) return true;
  if (lower.includes('load failed')) return true; // Safari fetch failure
  if (lower.includes('aborted') || lower.includes('abort')) return true;
  if (lower.includes('timeout') || lower.includes('timed out')) return true;
  if (lower.includes('connection')) return true;
  if (/\b5\d{2}\b/.test(message)) return true; // 500, 502, 503, 504 etc
  if (lower.includes('status code')) return true;
  if (lower.includes('transport error')) return true; // tonic-web-wasm-client
  if (lower.includes('rpc error')) return true;
  return false;
}
