import { AccountId, Address, MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

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
 * Register the final account with the mainnet node. Keep the same account ID for retries.
 * Check access first to keep an unused code when the account is already allowed.
 * Node and transport failures are thrown so the caller can show a retry action.
 */
export async function redeemMainnetAccessCode(
  code: string,
  target?: MainnetAccessTarget
): Promise<MainnetAccessOutcome> {
  if (!code) return 'rejected';
  if (!target) throw new Error('Mainnet registration requires an account ID and RPC URL');
  await MidenClient.ready();
  return withWasmClientLock(async () => {
    const accountId = target.accountId.startsWith('0x')
      ? AccountId.fromHex(target.accountId)
      : Address.fromBech32(target.accountId.split('_')[0] ?? target.accountId).accountId();
    if (getEffectiveRpcUrl() !== target.rpcUrl) throw new Error('Account registration RPC differs from wallet RPC');
    const { client } = await getMidenClient();
    if (await client.accounts.isAllowed(accountId)) return 'granted';
    try {
      // Sync the backend client to set the genesis metadata required by v17 registration.
      await client.sync();
      await client.accounts.register({ account: accountId, invitationCode: code });
      return 'granted';
    } catch (error) {
      switch (extractSdkErrorCode(error)) {
        case 'INVITATION_NOT_FOUND':
        case 'INVALID_REGISTRATION_REQUEST':
          return 'rejected';
        case 'ALREADY_REGISTERED':
          // A concurrent request can register the same account after the first check.
          if (await client.accounts.isAllowed(accountId)) return 'granted';
          return 'rejected';
        default:
          throw error;
      }
    }
  });
}
