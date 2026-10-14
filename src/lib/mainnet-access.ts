import { AccountId, Address, MidenClient, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

/** The number of characters in a node-generated access code. */
export const MAINNET_ACCESS_CODE_LENGTH = 12;

export const isMainnetAccessCodeComplete = (code: string): boolean => /^(?:[0-9]{8}|[A-Za-z0-9]{12})$/.test(code);

export type MainnetAccessOutcome = 'granted' | 'rejected';

export interface MainnetAccessTarget {
  /** The final mainnet account ID, in hex or bech32 format. */
  accountId: string;
  /** The mainnet node that will receive the account's first transaction. */
  rpcUrl: string;
}

/**
 * Ask the node whether the code can register an account, before any account exists. A one-shot
 * `RpcClient` read, bounded by the RPC timeout, with no wallet client and no lock. The check does
 * not use the code: `redeemMainnetAccessCode` registers the final account with it after setup.
 * Node and transport failures are thrown so the caller can show a retry action.
 */
export async function checkMainnetAccessCode(code: string): Promise<MainnetAccessOutcome> {
  if (!code) return 'rejected';
  await MidenClient.ready();
  const rpc = new RpcClient(getRpcEndpoint());
  const valid = await withRpcTimeout(() => rpc.isInvitationCodeValid(code), 'mainnet-access-check');
  return valid ? 'granted' : 'rejected';
}

// One attempt per call: a retry would reach the client while the call that timed out still runs on it.
const bounded = <T>(call: () => Promise<T>, label: string) => withRpcTimeout(call, label, { retries: 0 });

const toAccountId = (accountId: string) =>
  accountId.startsWith('0x')
    ? AccountId.fromHex(accountId)
    : Address.fromBech32(accountId.split('_')[0] ?? accountId).accountId();

/**
 * Whether the mainnet node already admits the account, as a recovered one must be, since only a
 * new wallet brings a code. Node and transport failures, a timeout among them, are thrown.
 */
export async function isMainnetAccountAdmitted(accountId: string): Promise<boolean> {
  await MidenClient.ready();
  return withWasmClientLock(
    async () => {
      const id = toAccountId(accountId);
      const { client } = await getMidenClient();
      return bounded(() => client.accounts.isAllowed(id), 'mainnet-access-allowed');
    },
    { label: 'mainnet-access-admitted' }
  );
}

/**
 * Register the final account with the mainnet node. Keep the same account ID for retries.
 * Check access first to keep an unused code when the account is already allowed.
 * Node and transport failures, and a node call that outlives the RPC timeout, are thrown so the
 * caller can show a retry action; the retry finds the account allowed if the register landed.
 */
export async function redeemMainnetAccessCode(
  code: string,
  target?: MainnetAccessTarget
): Promise<MainnetAccessOutcome> {
  if (!code) return 'rejected';
  if (!target) throw new Error('Mainnet registration requires an account ID and RPC URL');
  await MidenClient.ready();
  return withWasmClientLock(
    async () => {
      const accountId = toAccountId(target.accountId);
      if (getEffectiveRpcUrl() !== target.rpcUrl) throw new Error('Account registration RPC differs from wallet RPC');
      const { client } = await getMidenClient();
      const isAllowed = () => bounded(() => client.accounts.isAllowed(accountId), 'mainnet-access-allowed');
      if (await isAllowed()) return 'granted';
      try {
        // Sync the backend client to set the genesis metadata required by v17 registration.
        await bounded(() => client.sync(), 'mainnet-access-sync');
        await bounded(
          () => client.accounts.register({ account: accountId, invitationCode: code }),
          'mainnet-access-register'
        );
        return 'granted';
      } catch (error) {
        switch (extractSdkErrorCode(error)) {
          case 'INVITATION_NOT_FOUND':
          case 'INVALID_REGISTRATION_REQUEST':
            return 'rejected';
          case 'ALREADY_REGISTERED':
            // A concurrent request can register the same account after the first check.
            if (await isAllowed()) return 'granted';
            return 'rejected';
          default:
            throw error;
        }
      }
    },
    { label: 'mainnet-access-redeem' }
  );
}
