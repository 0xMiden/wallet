/**
 * The Explore tab's catalog as the launcher draws it.
 *
 * The items and sections come from the effective network's document (`lib/explore-config`). This
 * module puts its text in the reader's language, applies the platform gate and adds what the code
 * keeps: the category chips, Recents and search. A section's `kind` picks its layout:
 *
 * - `featured`: a large card with the app's brand color behind its icon, its name, tagline and Open.
 * - `list`: every item as a row on the page margin in a plain group (logo tile, name, tagline, chevron).
 * - `recents`: the same rows, name only, newest first: the dApps the user opened last, from
 *   `recent-dapps.ts`. Not part of any category, and always last: a document can neither move nor
 *   remove it.
 */

import { IconName } from 'app/icons/v2';
import {
  EXPLORE_CATEGORIES,
  type ExploreCatalog,
  type ExploreCatalogItem,
  type ExploreCatalogSectionKind,
  type ExploreCategory,
  localizedText
} from 'lib/explore-config/schema';
import { isSwapEnabled } from 'lib/feature-flags';

/** A chip: every category, or one of them. */
export type ExploreFilter = 'all' | ExploreCategory;

/** A catalog item with its name and tagline in the reader's language. */
export type ExploreItem = Omit<ExploreCatalogItem, 'name' | 'tagline'> & { name: string; tagline: string };

/** A section the document lays out, or the search results, titled in the reader's language. */
export interface CatalogSection {
  id: string;
  kind: ExploreCatalogSectionKind;
  title: string;
  itemIds: string[];
}

export interface RecentsSection {
  id: 'recents';
  kind: 'recents';
  title: string;
}

export type ExploreSection = CatalogSection | RecentsSection;

export type ExploreSectionKind = ExploreSection['kind'];

/** What the launcher draws: the document's items and sections, then Recents. */
export interface ExploreView {
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

// Keyed by category, so every category a document may name has its chip.
const CATEGORY_CHIPS: Record<ExploreCategory, Omit<ExploreFilterDescriptor, 'id'>> = {
  tools: { labelKey: 'categoryTools', icon: IconName.Hammer },
  defi: { labelKey: 'categoryDefi', icon: IconName.Coins },
  games: { labelKey: 'categoryGames', icon: IconName.Rocket },
  nft: { labelKey: 'categoryNfts', icon: IconName.Image },
  learn: { labelKey: 'categoryLearn', icon: IconName.File }
};

/** The chips, in order. */
export const EXPLORE_FILTERS: ExploreFilterDescriptor[] = [
  { id: 'all', labelKey: 'all', icon: IconName.Apps },
  ...EXPLORE_CATEGORIES.map(id => ({ id, ...CATEGORY_CHIPS[id] }))
];

/**
 * The catalog for this platform: it follows `isSwapEnabled`, so if swap is ever gated again (it was
 * once gated on iOS for App Store Guideline 3.1.5(iii), and is enabled everywhere today), exchange
 * items drop out of Explore with it. A document can only narrow this gate, never widen it. Call at
 * render time, after Capacitor is initialized.
 *
 * Hands the catalog back BY REFERENCE while swap is on, and the runtime shares that object with
 * every reader, so nothing may mutate a catalog item or section in place.
 */
export function getExploreCatalog(catalog: ExploreCatalog | null): ExploreCatalog | null {
  if (!catalog || isSwapEnabled()) return catalog;
  return { ...catalog, items: catalog.items.filter(item => !item.isExchange) };
}

/**
 * What the launcher draws: `catalog`'s text in `locale` (see `localizedText`), then Recents under
 * `recentsTitle`. With no catalog, Recents alone.
 */
export function localizeExploreCatalog(
  catalog: ExploreCatalog | null,
  locale: string,
  recentsTitle: string
): ExploreView {
  const recents: RecentsSection = { id: 'recents', kind: 'recents', title: recentsTitle };
  if (!catalog) return { items: [], sections: [recents] };
  return {
    items: catalog.items.map(item => ({
      ...item,
      name: localizedText(item.name, locale),
      tagline: localizedText(item.tagline, locale)
    })),
    sections: [
      ...catalog.sections.map(section => ({ ...section, title: localizedText(section.title, locale) })),
      recents
    ]
  };
}

/** A section with its items resolved and filtered, ready to render. */
export type ResolvedExploreSection =
  | { section: CatalogSection; items: ExploreItem[] }
  | { section: RecentsSection; items: [] };

/**
 * The sections to show under a chip, in order. Items are looked up by id and filtered to the
 * chip's category; a section left with no items is dropped. Recents belong to no category, so
 * they show under "All" only.
 */
export function resolveExploreSections(view: ExploreView, filter: ExploreFilter): ResolvedExploreSection[] {
  const byId = new Map(view.items.map(item => [item.id, item]));
  const resolved: ResolvedExploreSection[] = [];

  for (const section of view.sections) {
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
 * show them. An item matches when its name, tagline (as drawn, in the reader's language) or host
 * contains every word of the query, ignoring case. An empty query matches nothing: the page shows
 * its sections instead.
 */
export function searchExploreCatalog(view: ExploreView, filter: ExploreFilter, query: string): ExploreItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const seen = new Set<string>();
  const matches: ExploreItem[] = [];
  for (const { items } of resolveExploreSections(view, filter)) {
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
