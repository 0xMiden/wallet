/**
 * Hardcoded featured dApps shown on the launcher.
 *
 * PR-2 grows the list to 8 entries with brand colors + longer descriptions
 * for the hero carousel. We deliberately don't ship banner screenshots yet
 * — the carousel uses the brand color as the background and overlays the
 * icon + name + tagline. Banner art can be added later (PM/marketing
 * decision per the plan's open content questions).
 *
 * The hardcoded list lives client-side per the user's decision; remote
 * curation can be wired in later by switching this module to fetch a JSON
 * blob with the same shape.
 */

import faucetIcon from 'app/misc/dapp-icons/faucet.png';
import luminaIcon from 'app/misc/dapp-icons/lumina.png';
import midenIcon from 'app/misc/dapp-icons/miden.png';
import zoroIcon from 'app/misc/dapp-icons/zoro.png';

export type FeaturedDappCategory = 'defi' | 'nft' | 'tools' | 'social';
export type FeaturedDappBadge = 'featured' | 'new' | 'verified';

export interface FeaturedDapp {
  id: string;
  name: string;
  url: string;
  /** Bundled icon — fetched from each dApp's homepage at packaging time
   *  (see scripts/fetch-dapp-icons.mjs). All icons are normalized to
   *  256×256 PNG with transparent backgrounds so the tile background
   *  shows through uniformly. */
  icon: string;
  /** One-line tagline shown under the dApp name in tiles and carousel cards. */
  shortDescription: string;
  /** Brand color used as the carousel card background and tile fallback. */
  brandColor: string;
  category: FeaturedDappCategory;
  badge?: FeaturedDappBadge;
  /** Marks dApps that should appear in the hero carousel (vs. just the grid). */
  featured?: boolean;
}

export const FEATURED_DAPPS: FeaturedDapp[] = [
  {
    id: 'miden',
    name: 'Miden',
    url: 'https://miden.xyz',
    icon: midenIcon,
    shortDescription: 'The privacy layer for the new internet',
    brandColor: '#FF5700',
    category: 'tools',
    badge: 'verified',
    featured: true
  },
  {
    id: 'zoro',
    name: 'Zoro',
    url: 'https://app.zoroswap.com/',
    icon: zoroIcon,
    shortDescription: 'Private swaps on Miden',
    brandColor: '#1D4ED8',
    category: 'defi',
    badge: 'featured',
    featured: true
  },
  {
    id: 'faucet',
    name: 'Faucet',
    url: 'https://faucet.testnet.miden.io/',
    icon: faucetIcon,
    shortDescription: 'Get testnet MIDEN tokens',
    brandColor: '#0EA5E9',
    category: 'tools',
    badge: 'verified'
  },
  {
    id: 'lumina',
    name: 'Lumina Engine',
    url: 'https://beta.luminaengine.ai/',
    icon: luminaIcon,
    shortDescription: 'AI engine on Miden',
    brandColor: '#FACC15',
    category: 'defi',
    badge: 'new',
    featured: true
  }
];

/** dApps surfaced in the hero carousel — subset of FEATURED_DAPPS. */
export const CAROUSEL_DAPPS = FEATURED_DAPPS.filter(d => d.featured);
