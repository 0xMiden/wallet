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
import { u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import { getSignerDetailsFromAccount } from './account';
import { WalletSigner, type SignWordFunction } from './signer';
import { fetchFromStorage } from '../front/storage';
import { accountIdStringToSdk } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientInterface } from '../sdk/miden-client-interface';

const MAX_SYNC_RETRIES = 20;

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
    const guardianEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
      const webClient = (await MidenClientInterface.create({})).client;

      const client = new MultisigClient(webClient, { guardianEndpoint });
      const multisig = await client.load(account.id().toString(), signer);

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
    console.log('Importing account from Guardian with accountId:', accountId);
    const guardianEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
    console.log('Using Guardian endpoint:', guardianEndpoint);
    const guardian = new GuardianHttpClient(guardianEndpoint);
    const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
    guardian.setSigner(signer);
    try {
      const { stateJson } = await guardian.getState(accountId);
      const accountBase64 = stateJson.data;
      const binaryString = atob(accountBase64);
      const accountBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        accountBytes[i] = binaryString.charCodeAt(i);
      }
      const account = Account.deserialize(accountBytes);
      await webClient.accounts.insert({ account, overwrite: true });
    } catch (error) {
      console.log('Error fetching account state from Guardian:', error);
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
    return this.multisig.createP2idProposal(
      accountIdStringToSdk(recipientId).toString(),
      accountIdStringToSdk(faucetId).toString(),
      amount
    );
  }

  /**
   * Create a consume notes transaction proposal.
   */
  async createConsumeNotesProposal(noteIds: string[]): Promise<Proposal> {
    return this.multisig.createConsumeNotesProposal(noteIds);
  }

  /**
   * Create a custom transaction proposal from a TransactionSummary.
   * This is used for 'execute' type transactions.
   */
  async createCustomProposal(summaryBytes: Uint8Array): Promise<Proposal> {
    const txSummaryBase64 = u8ToB64(summaryBytes);

    // Sync state to ensure we have the latest nonce
    await this.multisig.syncState();
    const account = this.multisig.account;
    if (!account) {
      throw new Error('Account not found in MultisigService');
    }
    // +2 accounts for the current nonce plus the proposal execution incrementing nonce
    const nonce = Number(account.nonce().asInt()) + 2;

    // Create metadata for unknown/custom proposal type
    const metadata: ProposalMetadata = {
      proposalType: 'unknown',
      description: 'Custom transaction'
    };
    const proposal = await this.multisig.createProposal(nonce, txSummaryBase64, metadata);

    return proposal;
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

  async signAndExecuteProposal(id: string): Promise<void> {
    await this.multisig.signProposal(id);
    await this.multisig.executeProposal(id);
  }

  async signAndCreateTransactionRequest(id: string): Promise<TransactionRequest> {
    const singedProposal = await this.multisig.signProposal(id);
    console.log('Signed proposal, creating transaction request with id:', singedProposal.signatures);
    return await this.multisig.createTransactionProposalRequest(id);
  }

  async sync(): Promise<void> {
    try {
      await this.multisig.syncState();
      this.syncRetryCount = 0; // Reset retry count on successful sync
    } catch (error) {
      console.log('[Guardian] sync error ', error);
      const isNonceTooLow =
        error instanceof Error && error.message.includes('nonce') && error.message.includes('too low');

      if (isNonceTooLow) {
        console.warn('Nonce is too low, local state is ahead of on chain state, retrying sync...', this.syncRetryCount);

        if (this.syncRetryCount < MAX_SYNC_RETRIES) {
          this.syncRetryCount++;
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait before retrying
          await this.sync();
        } else {
          throw new Error('Max sync retries reached: local state is ahead of on-chain state');
        }
      } else {
        throw error; // Rethrow if it's a different error
      }
    }
  }

  async getConsumableNotes() {
    return this.multisig.getConsumableNotes();
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
      const { commitment } = await newGuardian.getPubkey('ecdsa');
      const proposal = await this.multisig.createSwitchGuardianProposal(newGuardianEndpoint, commitment);
      await this.multisig.createProposal(proposal.nonce, proposal.txSummary, proposal.metadata);
      console.log('Created switch-guardian proposal with new endpoint:', newGuardianEndpoint);
      return { proposal, newEndpoint: newGuardianEndpoint };
    } catch (error) {
      console.log('Error creating switch-guardian proposal:', error);
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
      const { commitment } = await nextGuardian.getPubkey();

      this.multisig.setGuardianClient(nextGuardian);
      this.multisig.guardianPublicKey = commitment;
      this.guardianEndpoint = newGuardianEndpoint;

      await this.multisig.registerOnGuardian(updatedStateBase64);
    } catch (error) {
      console.log('Error finalizing guardian switch:', error);
      throw error;
    }
  }
}

// Re-export types that may be needed by consumers
export type { TransactionProposal, ProposalMetadata };
