/**
 * WalletConnect (dApp side) configuration.
 *
 * The wallet uses WalletConnect to call out to an external EVM wallet
 * (MetaMask, Rainbow, etc.) so the bridge flow can sign EVM-side transactions.
 * We're the dApp here; the user's EVM funds live in the external wallet.
 */

export const WC_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID ?? '';

export type EvmChain = {
  id: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

const RPC = (id: number) => `https://rpc.walletconnect.org/v1?chainId=eip155:${id}&projectId=${WC_PROJECT_ID}`;

export const SUPPORTED_CHAINS: EvmChain[] = [
  {
    id: 11155111,
    name: 'Sepolia',
    rpcUrl: RPC(11155111),
    explorer: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'SepoliaETH', decimals: 18 }
  }
];

export const DEFAULT_CHAIN_ID = 11155111;

export const APP_METADATA = {
  name: 'Bread Wallet',
  description: 'Bread — Miden wallet. Sign EVM transactions to bridge assets to and from Miden.',
  url: 'https://miden.io',
  icons: ['https://miden.io/favicon.ico']
};

export function getChain(id: number): EvmChain | undefined {
  return SUPPORTED_CHAINS.find(c => c.id === id);
}
