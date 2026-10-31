import arbitrumone from 'app/icons/logos/networks/arbitrum-one.svg?url';
import arc from 'app/icons/logos/networks/arc.svg?url';
import avalanche from 'app/icons/logos/networks/avalanche.svg?url';
import base from 'app/icons/logos/networks/base.svg?url';
import hyperevm from 'app/icons/logos/networks/hyper-evm.svg?url';
import monad from 'app/icons/logos/networks/monad.svg?url';
import optimism from 'app/icons/logos/networks/optimism.svg?url';
import polygon from 'app/icons/logos/networks/polygon.svg?url';
import robinhood from 'app/icons/logos/networks/robinhood.svg?url';
import solana from 'app/icons/logos/networks/solana.svg?url';

export function networkLogo(network: string | undefined): string | undefined {
  switch (network) {
    case 'arc':
    case 'arc-testnet':
      return arc;
    case 'base':
    case 'base-sepolia':
      return base;
    case 'arbitrum':
    case 'arbitrum-sepolia':
      return arbitrumone;
    case 'avalanche':
    case 'avalanche-fuji':
      return avalanche;
    case 'optimism':
    case 'optimism-sepolia':
      return optimism;
    case 'polygon':
    case 'polygon-amoy':
      return polygon;
    case 'robinhood':
      return robinhood;
    case 'solana':
    case 'solana-devnet':
      return solana;
    case 'monad':
    case 'monad-testnet':
      return monad;
    case 'hyperevm':
    case 'hyperevm-testnet':
      return hyperevm;
    default:
      return undefined;
  }
}
