export type FaucetAddressHelpers = Pick<
  typeof import('lib/miden/sdk/helpers'),
  'accountRefToSdk' | 'getBech32AddressFromAccountId'
>;

export type FaucetAddressTarget = {
  __TEST_HEX_TO_BECH32_FAUCET__?: (hex: string) => string;
};

export async function installFaucetAddressTestHook(
  target: FaucetAddressTarget = globalThis as FaucetAddressTarget,
  loadHelpers: () => Promise<FaucetAddressHelpers> = () => import('lib/miden/sdk/helpers')
): Promise<void> {
  const { accountRefToSdk, getBech32AddressFromAccountId } = await loadHelpers();
  target.__TEST_HEX_TO_BECH32_FAUCET__ = hex => getBech32AddressFromAccountId(accountRefToSdk(hex));
}
