import type { Hex } from 'viem';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';

import { midenAccountHexToXReserveRecipient } from './recipient';

/**
 * The xReserve `remoteRecipient` of a Miden account, from any form the wallet holds it in: bech32, hex, or the
 * composite `<bech32>_<suffix>` wallet id. Throws for a reference that is no account id.
 */
export function usdcxRemoteRecipientFor(accountRef: string): Hex {
  return midenAccountHexToXReserveRecipient(accountRefToSdk(accountRef).toString());
}

/**
 * The remote token the wallet expects xReserve to name for a deposit to Miden: the native (USDCx) faucet id in the
 * same bytes32 encoding. Not a signed value: Circle reads it from xReserve's registry.
 */
export function usdcxExpectedRemoteTokenFor(faucetRef: string): Hex {
  return midenAccountHexToXReserveRecipient(accountRefToSdk(faucetRef).toString());
}
