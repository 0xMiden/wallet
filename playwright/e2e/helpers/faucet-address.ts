import type { ChromeWalletPageApi } from './wallet-page';
import type { EnvironmentConfig } from '../harness/types';

export function hexFaucetToBech32(
  wallet: ChromeWalletPageApi,
  faucetHex: string,
  environment: EnvironmentConfig['name'] = 'testnet'
): Promise<string> {
  const network = environment === 'localhost' ? 'localnet' : environment;
  if (network !== 'testnet' && network !== 'devnet' && network !== 'localnet') {
    throw new Error(`Unsupported E2E network for faucet address: ${environment}`);
  }
  const faucetNetwork: 'testnet' | 'devnet' | 'localnet' = network;
  return wallet.page.evaluate(
    ({ faucetHex, faucetNetwork }) =>
      (
        window as never as {
          __TEST_HEX_TO_BECH32_FAUCET__: (hex: string, network: 'testnet' | 'devnet' | 'localnet') => string;
        }
      ).__TEST_HEX_TO_BECH32_FAUCET__(faucetHex, faucetNetwork),
    { faucetHex, faucetNetwork }
  );
}
