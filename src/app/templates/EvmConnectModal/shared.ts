export type BridgeProvider = 'epoch' | 'agglayer';

export type BridgeTab = 'miden-to-evm' | 'evm-to-miden';

export interface EvmToken {
  symbol: string;
  address: string;
  decimals: number;
}

// Hardcoded Sepolia testnet tokens for the bridge UI. Replaced by a real
// token picker once we have one.
export const SEPOLIA_TESTNET_TOKENS: EvmToken[] = [
  { symbol: 'USDC', address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69', decimals: 18 },
  { symbol: 'DAI', address: '0xc30f1Ce05d1434d484E9A47283aA925fc8A8699a', decimals: 18 },
  { symbol: 'USDT', address: '0xc04d2869665Be874881133943523723Be5782720', decimals: 18 },
  { symbol: 'WETH', address: '0x7946dd86eE310D0aC16804A37787289Fa5b88A8A', decimals: 18 },
  { symbol: 'WBTC', address: '0x9b2a2754a9182fD65360E23afCDf3BeFF51796E9', decimals: 18 },
  { symbol: 'PENGU', address: '0xEA7dC9849206Ce73b11c465d37b85eC06B11Cf2C', decimals: 18 },
  { symbol: 'OSWALD', address: '0xB588418c0f90F07Bc9587d0050845a90C23C7502', decimals: 18 },
  { symbol: 'KICK', address: '0x512Ee6Bd7A4be5Ba4796F15Df080c4D0F89a38eD', decimals: 18 },
  { symbol: 'FERB', address: '0x145e03A80c19ad1b9d0429d06b6d52707de724A0', decimals: 18 }
];

export function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export const inputClass =
  'rounded-lg border border-grey-200 bg-white px-3 py-2 text-sm text-heading-gray placeholder:text-grey-400 focus:outline-none focus:ring-2 focus:ring-primary-500/40';
