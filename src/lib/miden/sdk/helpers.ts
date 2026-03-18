import { AccountId, Address, NetworkId } from '@miden-sdk/miden-sdk';

export function getBech32AddressFromAccountId(accountId: AccountId): string {
  const accountAddress = Address.fromAccountId(accountId, 'BasicWallet');
  return accountAddress.toBech32(NetworkId.testnet());
}
