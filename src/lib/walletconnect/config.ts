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

// E2E-only: redirect Sepolia reads (balances, tx receipts) at a local Anvil so
// the bridge-in deposit harness runs against a hermetic chain instead of public
// Sepolia. Inert in production — `E2E_EVM_RPC_URL` is baked in only by the e2e
// build, and only when `MIDEN_E2E_TEST` is also on.
const E2E_EVM_RPC_URL = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.E2E_EVM_RPC_URL ?? '').trim() : '';

const RPC = (id: number) =>
  E2E_EVM_RPC_URL || `https://rpc.walletconnect.org/v1?chainId=eip155:${id}&projectId=${WC_PROJECT_ID}`;

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
