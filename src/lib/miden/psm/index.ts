import { Account, MidenClient, TransactionRequest, WebClient } from '@miden-sdk/miden-sdk';
import {
  Multisig,
  MultisigClient,
  GuardianHttpClient,
  type ProposalMetadata,
  type TransactionProposal,
  type Proposal
} from '@openzeppelin/miden-multisig-client';

import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';
import { u8ToB64 } from 'lib/shared/helpers';

import { fetchFromStorage } from '../front';
import { accountIdStringToSdk } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientInterface } from '../sdk/miden-client-interface';
import { WalletSigner, type SignWordFunction } from './signer';

const MAX_SYNC_RETRIES = 20;

/**
 * MultisigService wraps the MultisigClient and Multisig classes from
 * @openzeppelin/miden-multisig-client to provide a simplified interface
 * for PSM account operations.
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
   * Initialize a MultisigService for an existing PSM account.
   */
  static async init(
    account: Account,
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction
  ): Promise<MultisigService> {
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
      const guardianEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;

      const webClient = (await MidenClientInterface.create({})).client;

      const client = new MultisigClient(webClient, { guardianEndpoint });
      const multisig = await client.load(account.id().toString(), signer);

      return new MultisigService(multisig, client, guardianEndpoint);
    } catch (error) {
      console.log('Error initializing MultisigService:', error);
      throw error;
    }
  }

  static async importAccountFromPsm(
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction,
    accountId: string,
    webClient: MidenClient
  ) {
    const psmEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;
    const psm = new GuardianHttpClient(psmEndpoint);
    const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
    psm.setSigner(signer);
    try {
      const { stateJson } = await psm.getState(accountId);
      const accountBase64 = stateJson.data;
      const binaryString = atob(accountBase64);
      const accountBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        accountBytes[i] = binaryString.charCodeAt(i);
      }
      const account = Account.deserialize(accountBytes);
      await webClient.accounts.insert({ account, overwrite: true });
    } catch (error) {
      console.log('Error fetching account state from PSM:', error);
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

  async signAndExecuteProposal(id: string): Promise<void> {
    await this.multisig.signProposal(id);
    await this.multisig.executeProposal(id);
  }

  async signAndCreateTransactionRequest(id: string): Promise<TransactionRequest> {
    await this.multisig.signProposal(id);
    return await this.multisig.createTransactionProposalRequest(id);
  }

  async sync(): Promise<void> {
    try {
      await this.multisig.syncState();
      this.syncRetryCount = 0; // Reset retry count on successful sync
    } catch (error) {
      console.log('[PSM] sync error ', error);
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
      const { commitment } = await newGuardian.getPubkey();
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
