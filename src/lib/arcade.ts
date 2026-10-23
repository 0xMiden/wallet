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

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Display classification only, never an authorization or proof of a game outcome. */
export function arcadeActivityMatcher(
  catalog: ExploreCatalog | null | undefined
): (entry: { dappOrigins?: readonly string[] }) => boolean {
  const origins = new Set(
    catalog?.items
      .filter(item => getExploreCategoryGroup(item.category) === 'arcade')
      .flatMap(item => {
        const origin = originOf(item.url);
        return origin ? [origin] : [];
      })
  );
  return entry =>
    entry.dappOrigins?.some(origin => {
      const normalized = originOf(origin);
      return normalized !== undefined && origins.has(normalized);
    }) ?? false;
}
