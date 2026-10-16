import type { SolanaNetworkId } from './types';

export interface SolanaNetwork {
  id: SolanaNetworkId;
  name: string;
  cluster: 'mainnet-beta' | 'devnet';
  rpcUrl: string;
  explorer: string;
  testnet: boolean;
  usdcMint: string;
}

export const SOLANA_NETWORKS: readonly SolanaNetwork[] = [
  {
    id: 'solana',
    name: 'Solana',
    cluster: 'mainnet-beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorer: 'https://explorer.solana.com',
    testnet: false,
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  },
  {
    id: 'solana-devnet',
    name: 'Solana Devnet',
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com',
    testnet: true,
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  }
];

export function getSolanaNetwork(id: string): SolanaNetwork | undefined {
  return SOLANA_NETWORKS.find(network => network.id === id);
}
