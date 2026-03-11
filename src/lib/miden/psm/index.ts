import { Account } from '@miden-sdk/miden-sdk';
import {
  Multisig,
  MultisigClient,
  MultisigConfig,
  PsmHttpClient,
  type ProposalMetadata,
  type TransactionProposal,
  type TransactionProposalResult
} from '@openzeppelin/miden-multisig-client';

import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';
import { u8ToB64 } from 'lib/shared/helpers';
import { useWalletStore } from 'lib/store';

import { fetchFromStorage } from '../front';
import { accountIdStringToSdk } from '../sdk/helpers';
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
  syncRetryCount: number = 0;

  constructor(multisig: Multisig, client: MultisigClient) {
    this.multisig = multisig;
    this.client = client;
  }

  /**
   * Initialize a MultisigService for an existing PSM account.
   */
  static async init(
    account: Account,
    publicKey: string,
    signerCommitment: string,
    signCallback?: (publicKey: string, signingInputs: string) => Promise<Uint8Array>
  ): Promise<MultisigService> {
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, useWalletStore.getState().signWord);
      const psmEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;

      const webClient = (
        await MidenClientInterface.create(
          signCallback
            ? {
                signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
                  const keyString = Buffer.from(publicKey).toString('hex');
                  const signingInputsString = Buffer.from(signingInputs).toString('hex');
                  return await signCallback(keyString, signingInputsString);
                }
              }
            : {}
        )
      ).webClient;

      const client = new MultisigClient(webClient, { psmEndpoint });
      const { psmCommitment } = await client.initialize('falcon');

      // Load the existing multisig account
      let multisig: Multisig;
      if (account.isNew()) {
        console.log('Creating new Multisig for account:', account.id().toString());
        const config: MultisigConfig = {
          threshold: 1,
          signerCommitments: [signerCommitment],
          psmCommitment: psmCommitment,
          psmEnabled: true
        };
        const psmClient = new PsmHttpClient(psmEndpoint);
        psmClient.setSigner(signer);
        multisig = new Multisig(account, config, psmClient, signer, webClient);
        await multisig.registerOnPsm();
      } else {
        multisig = await client.load(account.id().toString(), signer);
      }
      return new MultisigService(multisig, client);
    } catch (error) {
      console.log('Error initializing MultisigService:', error);
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
  async createSendProposal(recipientId: string, faucetId: string, amount: bigint): Promise<TransactionProposalResult> {
    return this.multisig.createSendProposal(
      accountIdStringToSdk(recipientId).toString(),
      accountIdStringToSdk(faucetId).toString(),
      amount
    );
  }

  /**
   * Create a consume notes transaction proposal.
   */
  async createConsumeNotesProposal(noteIds: string[]): Promise<TransactionProposalResult> {
    return this.multisig.createConsumeNotesProposal(noteIds);
  }

  /**
   * Create a custom transaction proposal from a TransactionSummary.
   * This is used for 'execute' type transactions.
   */
  async createCustomProposal(summaryBytes: Uint8Array): Promise<TransactionProposalResult> {
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
    const proposals = await this.multisig.syncTransactionProposals();

    return { proposal, proposals };
  }

  async signAndExecuteProposal(commitment: string): Promise<void> {
    await this.multisig.signTransactionProposal(commitment);
    await this.multisig.executeTransactionProposal(commitment);
  }

  async sync(): Promise<void> {
    try {
      await this.multisig.syncAll();
      this.syncRetryCount = 0; // Reset retry count on successful sync
    } catch (error) {
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
}

// Re-export types that may be needed by consumers
export type { TransactionProposal, TransactionProposalResult, ProposalMetadata };
