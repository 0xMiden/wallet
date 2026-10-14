import { AccountId, Address, MidenClient, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { assertWasmHoldCurrent, getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
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

/**
 * The ceiling on a hold that runs the access-code node calls. A call is never raced inside the hold:
 * one abandoned by a race keeps borrowing the client under the next holder, so a stalled call ends
 * only through the watchdog's eviction, which replaces the client.
 */
export const MAINNET_ACCESS_WATCHDOG_MS = 60_000;

const toAccountId = (accountId: string) =>
  accountId.startsWith('0x')
    ? AccountId.fromHex(accountId)
    : Address.fromBech32(accountId.split('_')[0] ?? accountId).accountId();

/**
 * Whether the mainnet node already admits the account, as a recovered one must be, since only a
 * new wallet brings a code. Node and transport failures, a watchdog eviction among them, are thrown.
 */
export async function isMainnetAccountAdmitted(accountId: string): Promise<boolean> {
  await MidenClient.ready();
  return withWasmClientLock(
    async hold => {
      const id = toAccountId(accountId);
      const { client } = await getMidenClient();
      assertWasmHoldCurrent(hold, 'in the mainnet admission read after the client build');
      const allowed = await client.accounts.isAllowed(id);
      assertWasmHoldCurrent(hold, 'in the mainnet admission read after the access check');
      return allowed;
    },
    { watchdogMs: MAINNET_ACCESS_WATCHDOG_MS, label: 'mainnet-access-admitted' }
  );
}

/**
 * Register the final account with the mainnet node. Keep the same account ID for retries.
 * Check access first to keep an unused code when the account is already allowed.
 * Node and transport failures, and a watchdog eviction of a stalled node call, are thrown so the
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
    async hold => {
      const accountId = toAccountId(target.accountId);
      if (getEffectiveRpcUrl() !== target.rpcUrl) throw new Error('Account registration RPC differs from wallet RPC');
      const { client } = await getMidenClient();
      // An evicted callback keeps running after its caller saw the eviction, so each await is
      // re-checked before the next client call.
      assertWasmHoldCurrent(hold, 'in the access-code redeem after the client build');
      const isAllowed = async () => {
        const allowed = await client.accounts.isAllowed(accountId);
        assertWasmHoldCurrent(hold, 'in the access-code redeem after the access check');
        return allowed;
      };
      if (await isAllowed()) return 'granted';
      try {
        // Sync the backend client to set the genesis metadata required by v17 registration.
        await client.sync();
        assertWasmHoldCurrent(hold, 'in the access-code redeem after the sync');
        await client.accounts.register({ account: accountId, invitationCode: code });
        return 'granted';
      } catch (error) {
        switch (extractSdkErrorCode(error)) {
          case 'INVITATION_NOT_FOUND':
          case 'INVALID_REGISTRATION_REQUEST':
            return 'rejected';
          case 'ALREADY_REGISTERED':
            assertWasmHoldCurrent(hold, 'in the access-code redeem after the refused registration');
            // A concurrent request can register the same account after the first check.
            if (await isAllowed()) return 'granted';
            return 'rejected';
          default:
            throw error;
        }
      }
    },
    { watchdogMs: MAINNET_ACCESS_WATCHDOG_MS, label: 'mainnet-access-redeem' }
  );
}
