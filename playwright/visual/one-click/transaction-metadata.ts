import type { AssetMetadata } from '../../../src/lib/miden/metadata/types';

const metadata: Record<string, AssetMetadata> = {
  'miden1ethfixture': { symbol: 'ETH', name: 'Ether', decimals: 18, scaleIsUnknown: false },
  'miden1usdcxfixture': { symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: false }
};

export async function fetchTokenMetadata(faucetId: string): Promise<AssetMetadata> {
  const value = metadata[faucetId];
  if (!value) throw new Error('Unknown visual fixture faucet');
  return value;
}
