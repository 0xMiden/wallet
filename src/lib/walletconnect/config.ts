/**
 * WalletConnect (dApp side) configuration.
 *
 * The wallet uses WalletConnect to call out to an external EVM wallet
 * (MetaMask, Rainbow, etc.) so the bridge flow can sign EVM-side transactions.
 * We're the dApp here; the user's EVM funds live in the external wallet.
 */

import { Chain, defineChain } from 'viem';
import { arbitrumSepolia, baseSepolia } from 'viem/chains';

export const ARC_TESTNET = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } },
  testnet: true
});

/** The Reown project id every bundle uses unless `WALLETCONNECT_PROJECT_ID` is set at build time. */
const DEFAULT_WC_PROJECT_ID = 'd18d112eb50cbe764f03e51a90210611';

/**
 * `WALLETCONNECT_PROJECT_ID`: the vite defines bake this into app bundles at build
 * time, while Node consumers (the Playwright counterparty, jest) read it from
 * their own process env when this module loads. Both trim it and treat an unset,
 * empty or blank value as unset, falling back to `DEFAULT_WC_PROJECT_ID`.
 */
export const WC_PROJECT_ID = (process.env.WALLETCONNECT_PROJECT_ID ?? '').trim() || DEFAULT_WC_PROJECT_ID;

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

/** A viem chain read through the WalletConnect RPC, with its own explorer and native currency. */
function walletConnectChain(chain: Chain): EvmChain {
  return {
    id: chain.id,
    name: chain.name,
    rpcUrl: RPC(chain.id),
    explorer: chain.blockExplorers?.default.url ?? '',
    nativeCurrency: chain.nativeCurrency
  };
}

// Sepolia stays first: it is the default chain, and the WalletConnect RPC URL is read off it.
// Every chain here is proposed to a native WalletConnect session (`configureNativeReown`), so a
// request on it can be sent; the AppKit networks in `./appkit` must list the same chains.
export const SUPPORTED_CHAINS: EvmChain[] = [
  {
    id: 11155111,
    name: 'Sepolia',
    rpcUrl: RPC(11155111),
    explorer: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'SepoliaETH', decimals: 18 }
  },
  {
    id: ARC_TESTNET.id,
    name: ARC_TESTNET.name,
    rpcUrl: ARC_TESTNET.rpcUrls.default.http[0],
    explorer: ARC_TESTNET.blockExplorers.default.url,
    nativeCurrency: ARC_TESTNET.nativeCurrency
  },
  // USDCx withdrawal destinations: a burn's balance confirmation reads USDC on them.
  walletConnectChain(baseSepolia),
  walletConnectChain(arbitrumSepolia)
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
