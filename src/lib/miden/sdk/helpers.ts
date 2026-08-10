import { AccountId, Address } from '@miden-sdk/miden-sdk/lazy';

import { getNetworkId } from 'lib/miden-chain/constants';

export function getBech32AddressFromAccountId(accountId: AccountId): string {
  const accountAddress = Address.fromAccountId(accountId, 'BasicWallet');
  return accountAddress.toBech32(getNetworkId());
}

export function accountIdStringToSdk(accountIdStr: string): AccountId {
  return Address.fromBech32(accountIdStr).accountId();
}

/**
 * Canonicalize a wallet-account identifier so the two id forms that meet inside
 * the wallet compare equal. dApp/adapter-initiated transactions arrive with the
 * bare bech32 address (e.g. `mtst1…5068r3`), whereas `WalletAccount.publicKey` is
 * a composite `<address>_<suffix>` (e.g. `mtst1…5068r3_qr7qqq9wr6w`). Reduce both
 * to the SDK account id derived from the address portion; fall back to the raw
 * address portion if it can't be parsed.
 */
export function canonicalWalletAccountId(id: string): string {
  const address = id.split('_')[0] ?? id;
  try {
    return accountIdStringToSdk(address).toString();
  } catch {
    return address;
  }
}

/**
 * True when two ids refer to the same wallet account despite differing forms
 * (bare bech32 address vs composite `WalletAccount.publicKey`). Use this instead
 * of a raw `===` anywhere a dApp-supplied account id is matched against a stored
 * `WalletAccount.publicKey` — a raw compare misses on dApp txs and misroutes a
 * Guardian account through the non-guardian path (no co-signature → the on-chain
 * guardian auth fails as AUTH_UNAUTHORIZED).
 */
export function sameWalletAccountId(a: string, b: string): boolean {
  return canonicalWalletAccountId(a) === canonicalWalletAccountId(b);
}
