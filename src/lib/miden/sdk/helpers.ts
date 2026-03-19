import { AccountId, Address } from '@miden-sdk/miden-sdk';

import { getNetworkId } from 'lib/miden-chain/constants';

export function getBech32AddressFromAccountId(accountId: AccountId): string {
  const accountAddress = Address.fromAccountId(accountId, 'BasicWallet');
  return accountAddress.toBech32(getNetworkId());
}
