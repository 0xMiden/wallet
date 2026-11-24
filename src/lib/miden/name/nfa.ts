/**
 * Non-fungible asset (NFA) side of Miden Name.
 *
 * Ownership of a name is custody of its NFA, which the registry faucet mints.
 * This module reads the NFAs of an account vault (SDK `AssetVault.nonFungibleAssets`)
 * and matches one to a label through the domain commitment.
 *
 * Match rule: the vault key of a name NFA carries the first two felts of the
 * domain commitment in its first two limbs (the same two felts that key the
 * registry's `asset_status` and `token_to_domain` maps). A label matches an NFA
 * when the faucet is the registry and these two limbs are equal. A different
 * limb layout gives "not held", never a false positive.
 */

import { Account, NonFungibleAsset } from '@miden-sdk/miden-sdk/lazy';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { getMidenNameConfig, MIDEN_NAME_SLOTS, type MidenNameConfig } from './config';
import { type AccountIdParts, type Felts4, decodeDomainFelts } from './encoding';
import { MidenNameUnsupportedNetworkError } from './errors';
import { toAccountId } from './note';
import { readRegistryStorage } from './reads';
import { domainCommitment, feltsFromWord, idPartsFromHex, isRegistryNfa, keyMatchesCommitment } from './sdk-words';

export type DomainNfaHolding = 'held' | 'not-held';

function requireConfig(): MidenNameConfig {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return config;
}

/**
 * The NFA of `label` in the vault of `account`, or undefined. The returned
 * object is a borrow of the client that gave `account`; every other NFA of the
 * vault is freed here.
 */
export function findDomainNfa(
  account: Account,
  label: string,
  registry: AccountIdParts,
  registryHex: string
): NonFungibleAsset | undefined {
  const commitment = domainCommitment(label, registry);
  let found: NonFungibleAsset | undefined;
  for (const nfa of account.vault().nonFungibleAssets()) {
    if (
      found === undefined &&
      isRegistryNfa(nfa, registryHex) &&
      keyMatchesCommitment(feltsFromWord(nfa.vaultKey()), commitment)
    ) {
      found = nfa;
      continue;
    }
    nfa.free();
  }
  return found;
}

/** The vault keys of every registry NFA in the vault, as plain felts. Frees the NFAs. */
function registryNfaKeys(account: Account, registryHex: string): Felts4[] {
  const keys: Felts4[] = [];
  for (const nfa of account.vault().nonFungibleAssets()) {
    if (isRegistryNfa(nfa, registryHex)) keys.push(feltsFromWord(nfa.vaultKey()));
    nfa.free();
  }
  return keys;
}

/**
 * True when the account holds the NFA of `label`. Reads the local vault
 * snapshot under the WASM client lock; no RPC.
 */
export async function accountHoldsDomainNfa(accountId: string, label: string): Promise<DomainNfaHolding> {
  const config = requireConfig();
  const registry = idPartsFromHex(config.registryAccountIdHex);
  return withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(toAccountId(accountId).toString());
      assertWasmHoldCurrent(hold, 'miden-name-nfa-read: after the account read');
      if (!account) return 'not-held';
      const nfa = findDomainNfa(account, label, registry, config.registryAccountIdHex);
      if (!nfa) return 'not-held';
      nfa.free();
      return 'held';
    },
    { label: 'miden-name-nfa-read' }
  );
}

/**
 * The labels of every name whose NFA is in the vault of the account, from the
 * vault and the registry's `token_to_domain` map: no local registration
 * history is needed (for example after a restore). A label is listed only when
 * the commitment that the wallet computes for it matches the NFA key.
 */
export async function listOwnedDomainLabels(accountId: string): Promise<string[]> {
  const config = requireConfig();
  const registry = idPartsFromHex(config.registryAccountIdHex);
  const nfaKeys = await withWasmClientLock(
    async hold => {
      const account = await midenClientProxy.getAccount(toAccountId(accountId).toString());
      assertWasmHoldCurrent(hold, 'miden-name-nfa-list: after the account read');
      return account ? registryNfaKeys(account, config.registryAccountIdHex) : [];
    },
    { label: 'miden-name-nfa-list' }
  );
  if (nfaKeys.length === 0) return [];

  const mapKeys: Felts4[] = nfaKeys.map(key => [key[0], key[1], 0n, 0n]);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.tokenToDomain, keys: mapKeys }],
    'midenNameOwnedNames'
  );
  const labels: string[] = [];
  for (const key of mapKeys) {
    const label = decodeDomainFelts(storage.mapValue(MIDEN_NAME_SLOTS.tokenToDomain, key));
    if (label === null || labels.includes(label)) continue;
    if (keyMatchesCommitment(key, domainCommitment(label, registry))) labels.push(label);
  }
  return labels;
}
