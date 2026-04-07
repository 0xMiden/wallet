/**
 * Hardcoded featured dApps shown on the launcher.
 *
 * PR-1 keeps the same 4 favorites the old `Browser.tsx` had. PR-2's launcher
 * redesign expands this with a richer carousel/grid and adds remote-fetch
 * capability if PM wants the curation list to be updatable without an app
 * release. For now, hardcoded JSON per the user's decision.
 */

import faucetIcon from 'app/misc/dapp-icons/faucet.png';
import midenIcon from 'app/misc/dapp-icons/miden.png';
import xIcon from 'app/misc/dapp-icons/x.png';
import zoroIcon from 'app/misc/dapp-icons/zoro.png';

export interface FeaturedDapp {
  id: string;
  name: string;
  url: string;
  icon: string;
  /** Optional one-line description shown in the launcher carousel (PR-2) */
  shortDescription?: string;
  /** Optional category filter (PR-2 redesign) */
  category?: 'defi' | 'nft' | 'tools' | 'social';
  /** Optional badge displayed on the tile (PR-2 redesign) */
  badge?: 'featured' | 'new' | 'verified';
}

export const FEATURED_DAPPS: FeaturedDapp[] = [
  { id: 'miden', name: 'Miden', url: 'https://miden.xyz', icon: midenIcon, category: 'tools' },
  { id: 'zoro', name: 'Zoro', url: 'https://app.zoroswap.com/', icon: zoroIcon, category: 'defi' },
  {
    id: 'faucet',
    name: 'Faucet',
    url: 'https://faucet.testnet.miden.io/',
    icon: faucetIcon,
    category: 'tools'
  },
  { id: 'miden-x', name: 'Miden X', url: 'https://x.com/0xMiden', icon: xIcon, category: 'social' }
];
