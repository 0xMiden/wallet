/**
 * Installs the E2E-only hex-to-bech32 faucet-id hook the iOS harness uses to inject synthetic
 * metadata for a CLI-deployed test faucet.
 *
 * Composes the wallet's own two helpers rather than reaching for the SDK directly, so the address
 * it produces is the one the wallet keys balances and notes by, on whatever network is in effect -
 * including localnet and a developer endpoint override, which a hand-picked NetworkId could not
 * express.
 */
export async function installFaucetAddressTestHook(): Promise<void> {
  const { accountRefToSdk, getBech32AddressFromAccountId } = await import('lib/miden/sdk/helpers');
  (globalThis as { __TEST_HEX_TO_BECH32_FAUCET__?: (hex: string) => string }).__TEST_HEX_TO_BECH32_FAUCET__ = hex =>
    getBech32AddressFromAccountId(accountRefToSdk(hex));
}
