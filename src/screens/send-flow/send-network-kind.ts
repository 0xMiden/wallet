import type { NearIntentsAddressKind } from 'lib/one-click/types';
import type { AddressChain } from 'utils/miden';

/** The send network kind of an address chain, or undefined for a Miden address (a same-chain send). */
export function sendNetworkKind(chain: AddressChain): NearIntentsAddressKind | undefined {
  switch (chain) {
    case 'ethereum':
      return 'evm';
    case 'solana':
    case 'bitcoin':
    case 'near':
      return chain;
    case 'miden':
      return undefined;
  }
}
