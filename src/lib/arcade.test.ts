import { arcadeActivityMatcher, arcadeDiscovery } from './arcade';
import { localizeExploreCatalog } from './dapp-browser/explore-catalog';
import type { ExploreCatalog } from './explore-config/schema';

jest.mock('lib/feature-flags', () => ({ isSwapEnabled: () => true }));

const catalog: ExploreCatalog = {
  network: 'testnet',
  version: 1,
  items: [
    {
      id: 'game',
      category: 'games',
      name: { en: 'Game' },
      tagline: { en: 'Play' },
      url: 'https://game.example/play',
      isExchange: false
    },
    {
      id: 'second',
      category: 'games',
      name: { en: 'Second' },
      tagline: { en: 'Play again' },
      url: 'https://second.example/',
      isExchange: false
    },
    {
      id: 'finance',
      category: 'tools',
      name: { en: 'Finance' },
      tagline: { en: 'Tools' },
      url: 'https://finance.example/',
      isExchange: false
    }
  ],
  sections: [
    { id: 'features', kind: 'featured', title: { en: 'Features' }, itemIds: ['second', 'finance', 'game', 'missing'] },
    { id: 'games', kind: 'list', title: { en: 'Games' }, itemIds: ['game', 'second'] }
  ]
};

it('keeps published feature order, deduplicates games and excludes other categories', () => {
  const result = arcadeDiscovery(localizeExploreCatalog(catalog, 'en', 'Recents'));
  expect(result.featured.map(item => item.id)).toEqual(['second', 'game']);
  expect(result.games.map(item => item.id)).toEqual(['second', 'game']);
});

it('spotlights the first real game without adding fictional games or carousel slides', () => {
  const result = arcadeDiscovery(
    localizeExploreCatalog({ ...catalog, sections: catalog.sections.slice(1) }, 'en', 'Recents')
  );
  expect(result.featured.map(item => item.id)).toEqual(['game']);
  expect(result.games).toHaveLength(2);
  expect(arcadeDiscovery(localizeExploreCatalog(null, 'en', 'Recents'))).toEqual({ games: [], featured: [] });
});

it('classifies only exact recorded catalog-game origins, not tokens, names or lookalike hosts', () => {
  const matches = arcadeActivityMatcher(catalog);
  expect(matches({ dappOrigins: ['https://GAME.example'] })).toBe(true);
  expect(matches({ dappOrigins: ['https://second.example'] })).toBe(true);
  expect(matches({ dappOrigins: ['https://game.example.evil.test'] })).toBe(false);
  expect(matches({ dappOrigins: ['https://finance.example'] })).toBe(false);
  expect(matches({ dappOrigins: ['broken', 'null', 'file:///untrusted'] })).toBe(false);
  expect(matches({})).toBe(false);
  expect(arcadeActivityMatcher(null)({ dappOrigins: ['https://game.example'] })).toBe(false);
  expect(arcadeActivityMatcher(undefined)({ dappOrigins: ['https://game.example'] })).toBe(false);
  expect(arcadeActivityMatcher({ ...catalog, items: [] })({ dappOrigins: ['https://game.example'] })).toBe(false);
});
