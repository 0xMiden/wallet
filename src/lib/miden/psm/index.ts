import { Account, AccountId, TransactionSummary } from '@miden-sdk/miden-sdk';
import { PsmHttpClient, type Signer } from '@openzeppelin/psm-client';

import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

import { fetchFromStorage } from '../front';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { WalletSigner } from './signer';

const MAX_POLLING_ATTEMPTS = 20;

export class PsmService {
  psm: PsmHttpClient;
  signer: Signer;
  account: Account;

  constructor(signer: WalletSigner, psm: PsmHttpClient, account: Account) {
    this.signer = signer;
    this.psm = psm;
    this.account = account;
  }

  static async init(
    account: Account,
    accountPubkey: string,
    signerCommitment: string,
    signWordFn: (publicKey: string, wordHex: string) => Promise<string>
  ) {
    const signer = new WalletSigner(accountPubkey, signerCommitment, signWordFn);
    const psmEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;
    const client = new PsmHttpClient(psmEndpoint);
    client.setSigner(signer);
    console.log('Initialized PSM HTTP client with signer:', account.serialize());
    const configureRes = await client.configure({
      accountId: account.id().toString(),
      auth: {
        MidenFalconRpo: {
          cosigner_commitments: [signerCommitment]
        }
      },
      initialState: { data: u8ToB64(account.serialize()), accountId: account.id().toString() }
    });
    if (!configureRes.success) {
      throw new Error(`Failed to configure PSM client: ${configureRes.message}`);
    }
    return new PsmService(signer, client, account);
  }

  async sync() {
    const state = await this.psm.getState(this.account.id().toString());
    await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      const account = await midenClient.webClient.getAccount(AccountId.fromHex(state.accountId));
      if (!account || account.commitment().toHex() !== state.commitment) {
        const accountBytes = b64ToU8(state.stateJson.data);
        const account = Account.deserialize(accountBytes);
        await midenClient.webClient.newAccount(account, true);
      }
    });
  }

  async createTransactionProposal(txSummary: TransactionSummary): Promise<string> {
    console.log('account commitment', this.account.commitment().toHex());
    try {
      const b64Summary = u8ToB64(txSummary.serialize());
      const commitment = txSummary.toCommitment().toHex();
      const nonce = Number(this.account.nonce().asInt());
      const response = await this.psm.pushDeltaProposal({
        accountId: this.account.id().toString(),
        nonce,
        deltaPayload: {
          txSummary: { data: b64Summary },
          signatures: []
        }
      });
      console.log('Pushed delta proposal to PSM backend:', response);
      // Sign a proposal
      const delta = await this.psm.signDeltaProposal({
        accountId: this.account.id().toString(),
        commitment: response.commitment,
        signature: { scheme: 'falcon', signature: await this.signer.signCommitment(commitment) }
      });
      console.log('Signed delta proposal:', delta);
      // Execute a proposal
      const result = await this.psm.pushDelta({
        accountId: this.account.id().toString(),
        nonce: delta.nonce,
        prevCommitment: this.account.commitment().toHex(),
        deltaPayload: { data: b64Summary },
        status: {
          status: 'pending',
          timestamp: new Date().toISOString(),
          proposerId: this.signer.commitment,
          cosignerSigs: []
        }
      });

      // Sync if new commitment was generated
      if (result.newCommitment) {
        this.sync();
      }

      return new Promise((resolve, reject) => {
        let pollingAttempts = 0;
        const interval = setInterval(async () => {
          const proposalStatus = await this.psm.getDelta(this.account.id().toString(), nonce);
          pollingAttempts++;
          if (pollingAttempts > MAX_POLLING_ATTEMPTS) {
            clearInterval(interval);
            reject(new Error('Polling timed out'));
          }
          if (proposalStatus.status.status === 'canonical') {
            clearInterval(interval);
            this.sync();
            resolve(proposalStatus.newCommitment!);
          } else if (proposalStatus.status.status === 'discarded') {
            clearInterval(interval);
            reject(new Error('Proposal was rejected'));
          }
        }, 3000);
      });
    } catch (error) {
      console.error('Error in createTransactionProposal:', error);
      throw error;
    }
  }
}
