import type { EvmChain } from '../config';

const USDC = { name: 'USDC', symbol: 'USDC', decimals: 18 };

/** A chain the wallet knows no public RPC for, which no registry chain is. */
export const NO_PUBLIC_RPC_CHAIN: EvmChain = {
  id: 990001,
  name: 'No Public RPC',
  rpcUrl: 'https://rpc.walletconnect.org/v1?chainId=eip155:990001&projectId=secret',
  publicRpcUrl: '',
  explorer: 'https://explorer.example',
  nativeCurrency: USDC
};

/** A chain the wallet knows no explorer for, which no registry chain is. */
export const NO_EXPLORER_CHAIN: EvmChain = {
  id: 990002,
  name: 'No Explorer',
  rpcUrl: 'https://rpc.walletconnect.org/v1?chainId=eip155:990002&projectId=secret',
  publicRpcUrl: 'https://rpc.example',
  explorer: '',
  nativeCurrency: USDC
};

/**
 * `lib/walletconnect/config` whose `getChain` also knows `chains`, ahead of the registry, for a `jest.mock` factory,
 * which reads this module through `jest.requireActual` and passes the chains it wants, such as `[NO_EXPLORER_CHAIN]`.
 */
export function walletConnectConfigMock(chains: EvmChain[]): typeof import('../config') {
  const actual = jest.requireActual<typeof import('../config')>('lib/walletconnect/config');
  return { ...actual, getChain: (id: number) => chains.find(chain => chain.id === id) ?? actual.getChain(id) };
}
