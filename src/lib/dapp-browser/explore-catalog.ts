/**
 * The Explore tab's catalog: what it shows and in which sections, as data.
 *
 * Explore is laid out like an app store. A section has a `kind` that picks its layout, and holds
 * items by id; an item has a `type` (what it is) and a `category` (which chip it answers to). Adding
 * a Miden dApp, a game or an article is an entry in `items` plus an id in a section: the page
 * renders whatever the config holds, so no layout work is needed.
 *
 * - `featured`: a large card with the app's art or brand color, its name, tagline and Open.
 * - `list`: rows in one grouped card (icon, name, tagline, Open), with "See all" past `limit`.
 * - `row`: a horizontal row of app tiles, the name under each.
 * - `recents`: the dApps the user opened last, from `recent-dapps.ts`. Not part of any category.
 *
 * The dApp data itself stays in `FEATURED_DAPPS`; the catalog picks from it by id.
 */

import { IconName } from 'app/icons/v2';
import { isSwapEnabled } from 'lib/feature-flags';

import { FEATURED_DAPPS } from './featured-dapps';

/** The chip an item answers to. */
export type ExploreCategory = 'tools' | 'defi' | 'games' | 'nft' | 'learn';

/** A chip: every category, or one of them. */
export type ExploreFilter = 'all' | ExploreCategory;

export interface ExploreItem {
  id: string;
  category: ExploreCategory;
  name: string;
  /** One line under the name, in English: the fallback, and what search matches. */
  tagline: string;
  /** i18n key of the tagline, shown in place of `tagline` when set. */
  taglineKey?: string;
  url: string;
  /** The app's icon. Without one, the app shows its initial on a tint derived from its url. */
  icon?: string;
  /** Artwork for a featured card. Without it, the card shows the brand color behind the icon. */
  art?: string;
  brandColor?: string;
  /** A swap or exchange surface, hidden where the build ships without one (iOS). */
  isExchange?: boolean;
}

interface SectionBase {
  id: string;
  /** i18n key of the section title. */
  titleKey: string;
}

export interface FeaturedSection extends SectionBase {
  kind: 'featured';
  itemIds: string[];
}

export interface ListSection extends SectionBase {
  kind: 'list';
  itemIds: string[];
}

export interface RecentsSection extends SectionBase {
  kind: 'recents';
}

export type ExploreSection = FeaturedSection | ListSection | RecentsSection;

export type ExploreSectionKind = ExploreSection['kind'];

export interface ExploreCatalog {
  items: ExploreItem[];
  sections: ExploreSection[];
}

export interface ExploreFilterDescriptor {
  id: ExploreFilter;
  /** i18n key of the chip label. */
  labelKey: string;
  /** Glyph of the chip's "coming soon" state. */
  icon: IconName;
}

/** The chips, in order. */
export const EXPLORE_FILTERS: ExploreFilterDescriptor[] = [
  { id: 'all', labelKey: 'all', icon: IconName.Apps },
  { id: 'tools', labelKey: 'categoryTools', icon: IconName.Hammer },
  { id: 'defi', labelKey: 'categoryDefi', icon: IconName.Coins },
  { id: 'games', labelKey: 'categoryGames', icon: IconName.Rocket },
  { id: 'nft', labelKey: 'categoryNfts', icon: IconName.Image },
  { id: 'learn', labelKey: 'categoryLearn', icon: IconName.File }
];

/** A catalog item from a `FEATURED_DAPPS` entry, with any fields the catalog words differently. */
function fromDapp(
  id: string,
  category: ExploreCategory,
  overrides: Partial<Pick<ExploreItem, 'tagline' | 'taglineKey'>> = {}
): ExploreItem[] {
  return FEATURED_DAPPS.filter(dapp => dapp.id === id).map(dapp => ({
    id: dapp.id,
    category,
    name: dapp.name,
    tagline: dapp.shortDescription,
    url: dapp.url,
    icon: dapp.icon || undefined,
    brandColor: dapp.brandColor,
    isExchange: dapp.isExchange,
    ...overrides
  }));
}

export const EXPLORE_CATALOG: ExploreCatalog = {
  items: [
    ...fromDapp('faucet', 'tools'),
    ...fromDapp('forkchoice-faucet', 'tools', {
      tagline: 'Get testnet tokens for swap',
      taglineKey: 'exploreForkchoiceFaucetTagline'
    })
  ],
  sections: [
    { id: 'featured', kind: 'featured', titleKey: 'exploreFeatured', itemIds: ['faucet'] },
    { id: 'helper-tools', kind: 'list', titleKey: 'exploreHelperTools', itemIds: ['faucet', 'forkchoice-faucet'] },
    { id: 'recents', kind: 'recents', titleKey: 'recents' }
  ]
};

/**
 * The catalog for this platform: it follows `isSwapEnabled`, so if swap is ever gated again (it was
 * once gated on iOS for App Store Guideline 3.1.5(iii), and is enabled everywhere today), exchange
 * items drop out of Explore with it rather than needing a second switch. Call at render time, after
 * Capacitor is initialized.
 */
export function getExploreCatalog(catalog: ExploreCatalog = EXPLORE_CATALOG): ExploreCatalog {
  if (isSwapEnabled()) return catalog;
  return { ...catalog, items: catalog.items.filter(item => !item.isExchange) };
}

/** A section with its items resolved and filtered, ready to render. */
export type ResolvedExploreSection =
  | { section: FeaturedSection | ListSection; items: ExploreItem[] }
  | { section: RecentsSection; items: [] };

/**
 * The sections to show under a chip, in config order. Items are looked up by id and filtered to
 * the chip's category; a section left with no items is dropped. Recents belong to no category, so
 * they show under "All" only.
 */
export function resolveExploreSections(catalog: ExploreCatalog, filter: ExploreFilter): ResolvedExploreSection[] {
  const byId = new Map(catalog.items.map(item => [item.id, item]));
  const resolved: ResolvedExploreSection[] = [];

  for (const section of catalog.sections) {
    if (section.kind === 'recents') {
      if (filter === 'all') resolved.push({ section, items: [] });
      continue;
    }
    const items = section.itemIds
      .flatMap(id => {
        const item = byId.get(id);
        return item ? [item] : [];
      })
      .filter(item => filter === 'all' || item.category === filter);
    if (items.length > 0) resolved.push({ section, items });
  }

  return resolved;
}

/**
 * The catalog items matching a search query under a chip, each once, in the order the sections
 * show them. An item matches when its name, tagline or host contains every word of the query,
 * ignoring case. An empty query matches nothing: the page shows its sections instead.
 */
export function searchExploreCatalog(catalog: ExploreCatalog, filter: ExploreFilter, query: string): ExploreItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const seen = new Set<string>();
  const matches: ExploreItem[] = [];
  for (const { items } of resolveExploreSections(catalog, filter)) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const haystack = [item.name, item.tagline, hostOf(item.url)].join(' ').toLowerCase();
      if (words.every(word => haystack.includes(word))) matches.push(item);
    }
  }
  return matches;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
