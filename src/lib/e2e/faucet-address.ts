export type FaucetAddressNetwork = 'testnet' | 'devnet' | 'localnet';

export type FaucetAddressSdk = Pick<
  typeof import('@miden-sdk/miden-sdk/lazy'),
  'AccountId' | 'Address' | 'NetworkId'
>;

export function hexFaucetIdToBech32(
  sdk: FaucetAddressSdk,
  hex: string,
  network: FaucetAddressNetwork
): string {
  const accountId = sdk.AccountId.fromHex(hex);
  const networkId =
    network === 'localnet'
      ? sdk.NetworkId.custom('mlcl')
      : network === 'devnet'
        ? sdk.NetworkId.devnet()
        : sdk.NetworkId.testnet();
  return sdk.Address.fromAccountId(accountId, 'BasicWallet').toBech32(networkId);
}
