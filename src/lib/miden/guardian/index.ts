import { Account, MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  Multisig,
  MultisigClient,
  GuardianHttpClient,
  buildUpdateSignersTransactionRequest,
  executeForSummary,
  type ProposalMetadata,
  type TransactionProposal,
  type Proposal
} from '@openzeppelin/miden-multisig-client';

import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import * as secureHotKey from 'lib/secure-hot-key';
import type { GeneratedHotKey } from 'lib/secure-hot-key';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import { getSignerDetailsFromAccount } from './account';
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

  /**
   * Build a transient cold-bound MultisigService for ops that must be cold-signed
   * (switch_guardian co-sign and replace_hot_key). The cold commitment is read
   * from on-chain storage via getSignerDetailsFromAccount(_, true) — order
   * convention `[hot, cold]` is preserved across rotations because
   * createReplaceHotKeyProposal uses an in-place swap target list.
   *
   * Caller is expected to drop the returned service immediately after use so
   * cold key material doesn't outlive the operation.
   */
  static async buildColdMultisigService(
    account: Account,
    walletAccount: WalletAccount,
    signWordFn: SignWordFunction
  ): Promise<MultisigService> {
    if (!walletAccount.coldPublicKey) {
      throw new Error(`Guardian account ${walletAccount.publicKey} is missing coldPublicKey — re-create the wallet`);
    }
    const { commitment } = await getSignerDetailsFromAccount(account, true);
    return MultisigService.init(account, `0x${walletAccount.coldPublicKey}`, `0x${commitment}`, signWordFn);
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

  /** Current on-chain threshold for `procedure`, or undefined if none is set. */
  getProcedureThreshold(procedure: string): number | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.multisig as any).procedureThresholds?.get(procedure);
  }

  /**
   * The account's loaded on-chain auth structure: overall threshold, signer
   * commitments, and per-procedure thresholds. Used by the E2E harness to
   * assert the 3-key shape (e.g. that `update_guardian` is hardened to 2 and
   * the signer set is `[hot, cold]`) — properties the balance-only checks miss.
   */
  getAuthInfo(): { threshold: number; signerCommitments: string[]; procedureThresholds: Record<string, number> } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.multisig as any;
    const procedureThresholds: Record<string, number> = {};
    if (m.procedureThresholds instanceof Map) {
      for (const [proc, threshold] of m.procedureThresholds.entries()) {
        procedureThresholds[String(proc)] = threshold as number;
      }
    }
    return {
      threshold: typeof m.threshold === 'number' ? m.threshold : NaN,
      signerCommitments: Array.isArray(m.signerCommitments) ? m.signerCommitments.map(String) : [],
      procedureThresholds
    };
  }

  /** Create a proposal that sets `procedure`'s signature threshold to `threshold`. */
  async createUpdateProcedureThresholdProposal(procedure: string, threshold: number): Promise<Proposal> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return withWasmClientLock(() =>
      (this.multisig as any).createUpdateProcedureThresholdProposal(procedure, threshold)
    );
  }

  async signAndExecuteProposal(id: string): Promise<void> {
    // `signProposal` is signing + guardian HTTP (no shared-client access); only
    // `executeProposal` touches the WASM client and needs the mutex.
    await this.multisig.signProposal(id);
    await withWasmClientLock(() => this.multisig.executeProposal(id));
  }

  /**
   * Create a custom transaction proposal from a serialized transaction request.
   * This is used for 'execute' type transactions.
   */
  async createCustomProposal(requestBytes: Uint8Array, proposalType: string = 'custom transaction'): Promise<Proposal> {
    return await withWasmClientLock(() => this.multisig.createCustomProposal(requestBytes, proposalType));
  }

  /**
   * Sign a proposal with this service's bound signer. Used by switch_guardian's
   * cold co-sign path where cold contributes a signature without driving the
   * follow-up createTransactionProposalRequest call (hot does that).
   * Sigs accumulate on the Guardian server keyed by proposal id.
   */
  async signProposal(id: string): Promise<void> {
    await this.multisig.signProposal(id);
  }

  async signAndCreateTransactionRequest(id: string, requestBytes?: Uint8Array): Promise<TransactionRequest> {
    const proposal = await this.multisig.signProposal(id);
    if (proposal.metadata.proposalType === 'custom') {
      if (!requestBytes) {
        throw new Error('Request Bytes are required for custom execution');
      }
      const advice = await this.multisig.prepareCustomExecution(id, requestBytes);
      const request = TransactionRequest.deserialize(requestBytes);
      return request.extendAdviceMap(advice);
    }
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
   * Build a proposal that replaces this account's hot signer in-place. Mints a
   * fresh hot key via the secureHotKey facade and constructs an `update_signers`
   * proposal whose target list is `[newHotCommit, coldCommit]` (preserving the
   * `[hot, cold]` ordering convention so getSignerDetailsFromAccount keeps
   * working post-rotation).
   *
   * Bypasses the SDK's createAddSignerProposal/createRemoveSignerProposal
   * convenience wrappers (those compute different target lists). At execution
   * time, multisig.ts's buildTransactionRequestFromMetadata treats all three
   * `update_signers` variants identically and uses metadata.targetSignerCommitments
   * directly — so labeling this as 'add_signer' is cosmetic.
   *
   * Sign + submit this proposal with a cold-bound MultisigService — replacing
   * the hot key cannot itself require the hot key (recovery-friendly). Default
   * threshold for update_signers is 1, so cold alone satisfies it.
   *
   * Caller is responsible for persisting `newHot.ciphertext` BEFORE submitting
   * the resulting tx (see initiateReplaceHotKeyTransaction).
   */
  async createReplaceHotKeyProposal(account: Account): Promise<{ proposal: Proposal; newHot: GeneratedHotKey }> {
    const newHot = await secureHotKey.generateHotKey();
    const { commitment: coldCommitRaw } = await getSignerDetailsFromAccount(account, true);
    const ensure0x = (h: string): string => (h.startsWith('0x') ? h : `0x${h}`);
    const targetSignerCommitments = [ensure0x(newHot.commitmentHex), ensure0x(coldCommitRaw)];
    const targetThreshold = this.multisig.threshold;

    const webClient = (await getMidenClient()).client;
    const { request, salt } = await withWasmClientLock(async () =>
      buildUpdateSignersTransactionRequest(webClient, targetThreshold, targetSignerCommitments, {
        signatureScheme: 'ecdsa'
      })
    );
    const summary = await withWasmClientLock(async () => executeForSummary(webClient, this.accountId, request));
    const summaryBase64 = u8ToB64(summary.serialize());
    console.log(
      'Executed transaction for summary',
      summaryBase64,
      'with target signer commitments',
      targetSignerCommitments
    );
    const metadata: ProposalMetadata = {
      proposalType: 'add_signer',
      targetThreshold,
      targetSignerCommitments,
      saltHex: salt.toHex(),
      requiredSignatures: this.multisig.getEffectiveThreshold('add_signer'),
      description: 'Replace device (hot) signer'
    };

    const proposal = await this.multisig.createProposal(Date.now(), summaryBase64, metadata);
    console.log('Created replace-hot-key proposal:', proposal.id);
    return { proposal, newHot };
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
