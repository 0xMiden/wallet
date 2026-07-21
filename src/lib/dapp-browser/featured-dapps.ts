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
import midenNameIcon from 'app/misc/dapp-icons/miden-name.png';
import midenIcon from 'app/misc/dapp-icons/miden.png';
import playgroundIcon from 'app/misc/dapp-icons/playground.png';
import qashIcon from 'app/misc/dapp-icons/qash.png';
import zoroIcon from 'app/misc/dapp-icons/zoro.png';
import { isSwapEnabled } from 'lib/feature-flags';

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
  /** Short genre label shown between name and description on Explore grid cards (e.g. "DEX", "Neobank"). */
  genre?: string;
  /** Brand color used as the carousel card background and tile fallback. */
  brandColor: string;
  category: FeaturedDappCategory;
  badge?: FeaturedDappBadge;
  /** Marks dApps that should appear in the hero carousel (vs. just the grid). */
  featured?: boolean;
  /**
   * Marks a swap/exchange (DEX) surface. These are hidden from the curated
   * launcher on iOS, where the app ships without an exchange surface (Apple
   * treats in-app crypto exchange as requiring licensing under Guideline
   * 3.1.5(iii)). See `getExploreGridDapps` / `isSwapEnabled`.
   */
  isExchange?: boolean;
}

export const FEATURED_DAPPS: FeaturedDapp[] = [
  {
    id: 'miden',
    name: 'Miden',
    url: 'https://miden.xyz',
    icon: midenIcon,
    shortDescription: 'The privacy layer for the new internet',
    brandColor: '#E77537',
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
    genre: 'DEX',
    brandColor: '#1D4ED8',
    category: 'defi',
    badge: 'featured',
    featured: true,
    isExchange: true
  },
  {
    id: 'faucet',
    name: 'Faucet',
    url: 'https://faucet.testnet.miden.io/',
    icon: faucetIcon,
    shortDescription: 'Get testnet MIDEN tokens',
    genre: 'Helper Tool',
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
    genre: 'DEX',
    brandColor: '#FACC15',
    category: 'defi',
    badge: 'new',
    featured: true,
    isExchange: true
  },
  {
    id: 'qash',
    name: 'Qash',
    url: 'https://qash.finance/',
    icon: qashIcon,
    shortDescription: 'Private banking for global businesses',
    genre: 'Neobank',
    brandColor: '#2563EB',
    category: 'defi'
  },
  {
    id: 'playground',
    name: 'Playground',
    url: 'https://playground.miden.xyz/',
    icon: playgroundIcon,
    shortDescription: 'Build and test Miden contracts',
    brandColor: '#E77537',
    category: 'tools',
    badge: 'verified'
  },
  {
    id: 'miden-name',
    name: 'Miden Name',
    url: 'https://miden.name/',
    icon: midenNameIcon,
    shortDescription: 'Naming service for the Miden network',
    genre: 'Naming Service',
    brandColor: '#10B981',
    category: 'tools'
  }
];

/** dApps surfaced in the hero carousel — subset of FEATURED_DAPPS. */
export const CAROUSEL_DAPPS = FEATURED_DAPPS.filter(d => d.featured);

/** The four curated apps shown on the simplified Explore grid, in display order. */
export const EXPLORE_GRID_DAPPS: FeaturedDapp[] = ['zoro', 'qash', 'faucet', 'miden-name'].flatMap(id =>
  FEATURED_DAPPS.filter(d => d.id === id)
);

/**
 * The Explore grid for the current platform. On iOS, where the app ships
 * without a swap surface (App Store Guideline 3.1.5(iii)), swap/exchange (DEX)
 * dApps are filtered out so the launcher does not first-party-promote an
 * exchange the build otherwise omits. Off-iOS it returns EXPLORE_GRID_DAPPS
 * unchanged. Call at render time (not module scope) so the platform check runs
 * after Capacitor is initialized.
 */
export function getExploreGridDapps(): FeaturedDapp[] {
  return isSwapEnabled() ? EXPLORE_GRID_DAPPS : EXPLORE_GRID_DAPPS.filter(d => !d.isExchange);
}
