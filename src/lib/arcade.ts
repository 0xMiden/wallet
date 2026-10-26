import { parseOrigin } from 'lib/dapp-browser/dapp-session';
import {
  getExploreCategoryGroup,
  resolveExploreSections,
  type ExploreItem,
  type ExploreView
} from 'lib/dapp-browser/explore-catalog';
import type { ExploreCatalog } from 'lib/explore-config/schema';

export const ARCADE_PATH = '/browser?category=arcade';
export const ARCADE_COINS_PATH = '/arcade/coins';
export const ARCADE_ACTIVITY_PATH = '/history?filter=arcade&view=list';

/** Only games represented in this network's effective catalog, in published section order. */
export function arcadeDiscovery(view: ExploreView): { games: ExploreItem[]; featured: ExploreItem[] } {
  const sections = resolveExploreSections(view, 'arcade');
  const games = [...new Map(sections.flatMap(section => section.items).map(item => [item.id, item])).values()];
  const featured = [
    ...new Map(
      sections
        .filter(({ section }) => section.kind === 'featured')
        .flatMap(section => section.items)
        .map(item => [item.id, item])
    ).values()
  ];
  // With no editorial feature, spotlight the first available game rather than inventing a listing.
  return { games, featured: featured.length ? featured : games.slice(0, 1) };
}

/** Display classification only, never an authorization or proof of a game outcome. */
export function arcadeActivityMatcher(
  catalog: ExploreCatalog | null | undefined
): (entry: { dappOrigins?: readonly string[] }) => boolean {
  // Catalog URLs are validated https (or permitted local http), so an unparseable recorded origin never matches.
  const origins = new Set(
    catalog?.items
      .filter(item => getExploreCategoryGroup(item.category) === 'arcade')
      .map(item => parseOrigin(item.url))
  );
  return entry => entry.dappOrigins?.some(origin => origins.has(parseOrigin(origin))) ?? false;
}
