import {
  AccountId,
  AccountStorageRequirements,
  Endpoint,
  RpcClient,
  SlotAndKeys,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { getAgglayerMidenBridge } from 'lib/remote-config/values';

const REGISTRY_SLOT = 'agglayer::bridge::faucet_registry_map';
// The registry can drop a token, so an approval lasts only as long as this realm, and only for the bridge it was
// read from: a config that moves the bridge asks the new one.
const approved = new Set<string>();
const approvalKey = (rpcUrl: string, midenBridge: string, faucetId: string) => `${rpcUrl}|${midenBridge}|${faucetId}`;

export async function isAgglayerFaucetAllowed(faucetRef: string, rpcUrl: string): Promise<boolean> {
  await ensureSdkWasmReady();
  const midenBridge = getAgglayerMidenBridge();
  const faucet = accountRefToSdk(faucetRef);
  const approval = approvalKey(rpcUrl, midenBridge, faucet.toString());
  if (approved.has(approval)) return true;

  const registryKey = () => new Word(new BigUint64Array([0n, 0n, faucet.suffix().asInt(), faucet.prefix().asInt()]));
  const keyHex = registryKey().toHex();
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  // The SDK takes these arguments by value and frees them, so each attempt, a retry included, builds its own.
  const proof = await withRpcTimeout(
    () =>
      rpc.getAccountProof(
        AccountId.fromHex(midenBridge),
        AccountStorageRequirements.fromSlotAndKeysArray([new SlotAndKeys(REGISTRY_SLOT, [registryKey()])])
      ),
    'agglayer faucet registry'
  );
  const entries = proof.getStorageMapEntries(REGISTRY_SLOT);
  if (!entries || proof.hasStorageMapTooManyEntries(REGISTRY_SLOT)) {
    throw new Error('The bridge registry entries are unavailable.');
  }
  const entry = entries.find(item => item.key().toHex() === keyHex);
  if (!entry) throw new Error('The bridge registry did not return the requested key.');
  const allowed = entry.value().toU64s()[0] === 1n;
  if (allowed) approved.add(approval);
  return allowed;
}

/**
 * E2E-only: approve a runtime-created faucet the bridge registry does not list, for this endpoint and realm.
 * Production never calls this; the hook that does is installed only under MIDEN_E2E_TEST, like
 * setAgglayerSenderForE2E (bridge-in.ts).
 */
export async function allowAgglayerFaucetForE2E(faucetRef: string, rpcUrl: string): Promise<void> {
  await ensureSdkWasmReady();
  approved.add(approvalKey(rpcUrl, getAgglayerMidenBridge(), accountRefToSdk(faucetRef).toString()));
}
