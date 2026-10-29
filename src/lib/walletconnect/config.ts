/**
 * WalletConnect (dApp side) configuration.
 *
 * The wallet uses WalletConnect to call out to an external EVM wallet
 * (MetaMask, Rainbow, etc.) so the bridge flow can sign EVM-side transactions.
 * We're the dApp here; the user's EVM funds live in the external wallet.
 */

import { Chain, defineChain } from 'viem';
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, sepolia } from 'viem/chains';

export const ARC_TESTNET = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } },
  testnet: true
});

// viem's `arc` has no RPC and no explorer; these are Circle's, from https://docs.arc.io/arc/references/rpc-endpoints.
const ARC_MAINNET = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } }
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
  /**
   * The chain's public RPC endpoint. `wallet_addEthereumChain` sends this one to the external
   * wallet: `rpcUrl` can be the WalletConnect proxy, which carries our project id.
   */
  publicRpcUrl: string;
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
    publicRpcUrl: chain.rpcUrls.default.http[0] ?? '',
    explorer: chain.blockExplorers?.default.url ?? '',
    nativeCurrency: chain.nativeCurrency
  };
}

/** Chain definitions available to the parser, RPC reads, and connection adapters. */
export const EVM_CHAIN_DEFINITIONS: [Chain, ...Chain[]] = [
  sepolia,
  ARC_TESTNET,
  baseSepolia,
  arbitrumSepolia,
  mainnet,
  base,
  arbitrum,
  ARC_MAINNET,
  optimism
];

/**
 * `value` with every plain object and array copied, at any depth; functions and other values stay shared. Take one
 * before handing a shared chain above to code that keeps it: AppKit's valtio state proxies nested objects in place,
 * and IndexedDB cannot store a Proxy.
 */
export function copyPlainData<T>(value: T): T;
export function copyPlainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => copyPlainData(entry));
  if (typeof value !== 'object' || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyPlainData(entry)]));
}

/** This registry does not enable connections. The remote document selects those chains. */
export const SUPPORTED_CHAINS: EvmChain[] = EVM_CHAIN_DEFINITIONS.map(chain => {
  switch (chain.id) {
    case ARC_TESTNET.id:
    case ARC_MAINNET.id:
      return {
        ...walletConnectChain(chain),
        rpcUrl: chain.rpcUrls.default.http[0] ?? RPC(chain.id)
      };
    default:
      return walletConnectChain(chain);
  }
});

export const DEFAULT_CHAIN_ID = 11155111;

export const APP_METADATA = {
  name: 'Bread Wallet',
  description:
    'Bread Wallet connects to your Ethereum wallet for bridge deposits and claims. Review token approvals and transactions before confirming.',
  url: 'https://miden.io',
  icons: ['https://miden.io/favicon.ico']
};

export function getChain(id: number): EvmChain | undefined {
  return SUPPORTED_CHAINS.find(c => c.id === id);
}

/** `chain`'s explorer page for a transaction or an address, or undefined when the wallet knows no explorer for it. */
export function evmExplorerUrl(chain: EvmChain | undefined, kind: 'tx' | 'address', id: string): string | undefined {
  return chain?.explorer ? `${chain.explorer}/${kind}/${id}` : undefined;
}
