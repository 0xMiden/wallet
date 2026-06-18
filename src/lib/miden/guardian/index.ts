import { Account, MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  Multisig,
  MultisigClient,
  GuardianHttpClient,
  type ProposalMetadata,
  type TransactionProposal,
  type Proposal
} from '@openzeppelin/miden-multisig-client';

import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

import { WalletSigner, type SignWordFunction } from './signer';
import { fetchFromStorage } from '../front/storage';
import { accountIdStringToSdk } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

const MAX_SYNC_RETRIES = 20;
const SYNC_RETRY_DELAY_MS = 3000;
const MAX_GUARDIAN_REGISTER_RETRIES = 5;
const GUARDIAN_REGISTER_RETRY_DELAY_MS = 2000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * MultisigService wraps the MultisigClient and Multisig classes from
 * @openzeppelin/miden-multisig-client to provide a simplified interface
 * for Guardian account operations.
 */
export class MultisigService {
  multisig: Multisig;
  client: MultisigClient;
  guardianEndpoint: string;
  syncRetryCount: number = 0;
  // Dedupe overlapping `sync()` calls. The guardian sync fires every ~3s without
  // awaiting prior ticks, and the cached service instance is shared, so two ticks
  // could otherwise drive `syncState()` concurrently and clobber `syncRetryCount`.
  private syncInFlight: Promise<void> | null = null;

  constructor(multisig: Multisig, client: MultisigClient, guardianEndpoint: string) {
    this.multisig = multisig;
    this.client = client;
    this.guardianEndpoint = guardianEndpoint;
  }

  /**
   * Initialize a MultisigService for an existing Guardian account.
   */
  static async init(
    account: Account,
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction
  ): Promise<MultisigService> {
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
      const guardianEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;

      // Reuse the shared singleton client instead of spinning up a fresh
      // WebClient (each new WebClient spawns a ~6MB web-client-methods-worker
      // that is never terminated). Reusing the singleton also lets the multisig
      // lib's rawClientCache WeakMap (keyed by this client instance) hit across
      // every init, so at most ONE shared raw worker is created total.
      const webClient = (await getMidenClient()).client;

      const client = new MultisigClient(webClient, { guardianEndpoint });
      // `load` drives the shared WASM web-client, so it must be serialized with
      // every other client operation via the global mutex.
      const multisig = await withWasmClientLock(() => client.load(account.id().toString(), signer));

      return new MultisigService(multisig, client, guardianEndpoint);
    } catch (error) {
      console.log('Error initializing MultisigService:', error);
      throw error;
    }
  }

  static async importAccountFromGuardian(
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction,
    accountId: string,
    webClient: MidenClient
  ) {
    const guardianEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
    const guardian = new GuardianHttpClient(guardianEndpoint);
    const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
    guardian.setSigner(signer);
    try {
      const { stateJson } = await guardian.getState(accountId);
      const account = Account.deserialize(b64ToU8(stateJson.data));

      // The guardian is an untrusted remote: never overwrite local state with an
      // account whose ID doesn't match the one we requested, or a malicious /
      // misconfigured guardian could clobber a different local account.
      const returnedId = account.id().toString();
      if (returnedId !== accountId) {
        throw new Error(`Guardian returned account ${returnedId} but ${accountId} was requested`);
      }

      await webClient.accounts.insert({ account, overwrite: true });
    } catch (error) {
      console.error('Error fetching account state from Guardian:', error);
      throw error;
    }
  }

  /**
   * Get the account ID for this multisig.
   */
  get accountId(): string {
    return this.multisig.accountId;
  }

  /**
   * Create a send (P2ID) transaction proposal.
   */
  async createSendProposal(recipientId: string, faucetId: string, amount: bigint): Promise<Proposal> {
    return withWasmClientLock(() =>
      this.multisig.createP2idProposal(
        accountIdStringToSdk(recipientId).toString(),
        accountIdStringToSdk(faucetId).toString(),
        amount
      )
    );
  }

  /**
   * Create a consume notes transaction proposal.
   */
  async createConsumeNotesProposal(noteIds: string[]): Promise<Proposal> {
    return withWasmClientLock(() => this.multisig.createConsumeNotesProposal(noteIds));
  }

  async signAndExecuteProposal(id: string): Promise<void> {
    // `signProposal` is signing + guardian HTTP (no shared-client access); only
    // `executeProposal` touches the WASM client and needs the mutex.
    await this.multisig.signProposal(id);
    await withWasmClientLock(() => this.multisig.executeProposal(id));
  }

  async signAndCreateTransactionRequest(id: string): Promise<TransactionRequest> {
    await this.multisig.signProposal(id);
    return withWasmClientLock(() => this.multisig.createTransactionProposalRequest(id));
  }

  sync(): Promise<void> {
    // Coalesce overlapping ticks onto a single in-flight run so the retry
    // counter and `syncState` aren't driven concurrently. Not `async`: return
    // the cached promise itself so concurrent callers share one identity.
    if (this.syncInFlight) {
      return this.syncInFlight;
    }
    this.syncInFlight = this.runSync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runSync(): Promise<void> {
    // Iterative retry (not recursion): the WASM mutex is non-reentrant, so a
    // recursive `await this.sync()` while holding it would deadlock. We lock
    // around each `syncState` attempt and release during the back-off wait so
    // other client operations can proceed between retries.
    this.syncRetryCount = 0;
    for (;;) {
      try {
        await withWasmClientLock(() => this.multisig.syncState());
        this.syncRetryCount = 0; // Reset retry count on successful sync
        return;
      } catch (error) {
        const isNonceTooLow =
          error instanceof Error && error.message.includes('nonce') && error.message.includes('too low');
        if (!isNonceTooLow) {
          throw error; // Rethrow if it's a different error
        }
        if (this.syncRetryCount >= MAX_SYNC_RETRIES) {
          throw new Error('Max sync retries reached: local state is ahead of on-chain state');
        }
        this.syncRetryCount++;
        console.warn('Nonce is too low, local state is ahead of on-chain state, retrying sync...', this.syncRetryCount);
        await delay(SYNC_RETRY_DELAY_MS);
      }
    }
  }

  async getConsumableNotes() {
    return withWasmClientLock(() => this.multisig.getConsumableNotes());
  }

  /**
   * Build a switch-guardian proposal pointing at `newGuardianEndpoint`.
   * Caller is responsible for signing/submitting the proposal AND for
   * calling `finalizeGuardianSwitch` + persisting the endpoint only
   * after the on-chain switch commits.
   */
  async createSwitchGuardianProposal(
    newGuardianEndpoint: string
  ): Promise<{ proposal: Proposal; newEndpoint: string }> {
    try {
      const newGuardian = new GuardianHttpClient(newGuardianEndpoint);
      // Fetch the new guardian's ECDSA commitment to match the account's scheme.
      const { commitment } = await newGuardian.getPubkey('ecdsa');
      // `createSwitchGuardianProposal` already creates and returns the proposal;
      // calling `createProposal` again would duplicate it (nonce collision).
      const proposal = await withWasmClientLock(() =>
        this.multisig.createSwitchGuardianProposal(newGuardianEndpoint, commitment)
      );
      return { proposal, newEndpoint: newGuardianEndpoint };
    } catch (error) {
      console.error('Error creating switch-guardian proposal:', error);
      throw error;
    }
  }

  /**
   * Post-submit finalization for a switch-guardian proposal. Mirrors the
   * block that upstream's `multisig.executeProposal` runs when it detects
   * a `switch_guardian` metadata type. Must be called AFTER the on-chain
   * switch lands — `client.load(...)` against the new guardian will fail
   * until `registerOnGuardian` succeeds.
   *
   * By the time this runs the on-chain guardian has already been switched, so
   * the old guardian no longer has authority over the account. Registration on
   * the new guardian is therefore retried with back-off: a transient blip must
   * not be the difference between a usable account and one stranded between
   * guardians.
   */
  async finalizeGuardianSwitch(newGuardianEndpoint: string): Promise<void> {
    try {
      console.log('Finalizing guardian switch to new endpoint:', newGuardianEndpoint);
      const updatedStateBase64 = await withWasmClientLock(async () => {
        const client = await getMidenClient();
        await client.syncState();
        const account = await client.getAccount(this.accountId);
        if (!account) {
          throw new Error(`Updated account ${this.accountId} is missing from local client`);
        }
        return u8ToB64(account.serialize());
      });

      const nextGuardian = new GuardianHttpClient(newGuardianEndpoint);
      const { commitment } = await nextGuardian.getPubkey('ecdsa');

      this.multisig.setGuardianClient(nextGuardian);
      this.multisig.guardianPublicKey = commitment;
      this.guardianEndpoint = newGuardianEndpoint;

      await this.registerOnGuardianWithRetry(updatedStateBase64);
    } catch (error) {
      console.error('Error finalizing guardian switch:', error);
      throw error;
    }
  }

  private async registerOnGuardianWithRetry(stateBase64: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_GUARDIAN_REGISTER_RETRIES; attempt++) {
      try {
        await this.multisig.registerOnGuardian(stateBase64);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`registerOnGuardian failed (attempt ${attempt}/${MAX_GUARDIAN_REGISTER_RETRIES})`, error);
        if (attempt < MAX_GUARDIAN_REGISTER_RETRIES) {
          await delay(GUARDIAN_REGISTER_RETRY_DELAY_MS);
        }
      }
    }
    throw new Error('Failed to register account on the new guardian after switching', { cause: lastError });
  }
}

// Re-export types that may be needed by consumers
export type { TransactionProposal, ProposalMetadata };
