import {
  AccountId,
  AccountStorageRequirements,
  Endpoint,
  RpcClient,
  SlotAndKeys,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { fetchFromStorage, inStorageTurn, putToStorage } from 'lib/miden/front/storage';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { MIDEN_BRIDGE_ID } from './b2agg/constant';

const CACHE_KEY = 'allowed_agglayer_ids';
const REGISTRY_SLOT = 'agglayer::bridge::faucet_registry_map';

export async function isAgglayerFaucetAllowed(faucetRef: string, rpcUrl: string): Promise<boolean> {
  await ensureSdkWasmReady();
  const faucet = accountRefToSdk(faucetRef);
  const id = faucet.toString();
  // The configured bridge and this ID cache belong to testnet.
  const useCache = rpcUrl === 'https://rpc.testnet.miden.io';
  if (useCache && (await fetchFromStorage<string[]>(CACHE_KEY))?.includes(id)) return true;

  const key = new Word(new BigUint64Array([0n, 0n, faucet.suffix().asInt(), faucet.prefix().asInt()]));
  const requirements = AccountStorageRequirements.fromSlotAndKeysArray([new SlotAndKeys(REGISTRY_SLOT, [key])]);
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  const proof = await withRpcTimeout(
    () => rpc.getAccountProof(AccountId.fromHex(MIDEN_BRIDGE_ID), requirements),
    'agglayer faucet registry'
  );
  const entries = proof.getStorageMapEntries(REGISTRY_SLOT);
  if (!entries || proof.hasStorageMapTooManyEntries(REGISTRY_SLOT)) {
    throw new Error('The bridge registry entries are unavailable.');
  }
  const entry = entries.find(item => item.key().toHex() === key.toHex());
  if (!entry) throw new Error('The bridge registry did not return the requested key.');
  const allowed = entry.value().toU64s()[0] === 1n;
  if (allowed && useCache) {
    await inStorageTurn(CACHE_KEY, async () => {
      const ids = (await fetchFromStorage<string[]>(CACHE_KEY)) ?? [];
      if (!ids.includes(id)) await putToStorage(CACHE_KEY, [...ids, id]);
    });
  }
  return allowed;
}
