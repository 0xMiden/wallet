import { EXPLORE_CATEGORIES, type ExploreCatalog, RESERVED_SECTION_IDS } from 'lib/explore-config/schema';

import {
  EXPLORE_FILTERS,
  getExploreCatalog,
  localizeExploreCatalog,
  resolveExploreSections,
  searchExploreCatalog
} from './explore-catalog';

let mockSwapEnabled = true;
jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled
}));

const catalog: ExploreCatalog = {
  network: 'testnet',
  version: 1,
  items: [
    {
      id: 'faucet',
      category: 'tools',
      name: { en: 'Faucet' },
      tagline: { en: 'Mint', de: 'Prägen' },
      url: 'https://faucet.example',
      isExchange: false
    },
    {
      id: 'dex',
      category: 'defi',
      name: { en: 'Dex' },
      tagline: { en: 'Swap' },
      url: 'https://dex.example',
      isExchange: true
    },
    {
      id: 'quest',
      category: 'games',
      name: { en: 'Quest', de: 'Abenteuer' },
      tagline: { en: 'Play' },
      url: 'https://quest.example',
      isExchange: false
    }
  ],
  sections: [
    { id: 'featured', kind: 'featured', title: { en: 'Featured', de: 'Empfohlen' }, itemIds: ['faucet'] },
    { id: 'tools', kind: 'list', title: { en: 'Tools' }, itemIds: ['faucet', 'dex'] },
    { id: 'more', kind: 'list', title: { en: 'More' }, itemIds: ['dex', 'quest'] }
  ]
};
const view = (locale = 'en') => localizeExploreCatalog(catalog, locale, 'Recents');

beforeEach(() => {
  mockSwapEnabled = true;
});

describe('EXPLORE_FILTERS', () => {
  it('offers All first, then a chip for every category a document may name', () => {
    expect(EXPLORE_FILTERS.map(f => f.id)).toEqual(['all', 'tools', 'defi', 'games', 'nft', 'learn']);
    expect(EXPLORE_FILTERS.slice(1).map(f => f.id)).toEqual([...EXPLORE_CATEGORIES]);
  });
});

describe('localizeExploreCatalog', () => {
  it("draws the text in the reader's language, else English, and puts Recents last", () => {
    const german = view('de-DE');
    expect(german.items.map(item => [item.name, item.tagline])).toEqual([
      ['Faucet', 'Prägen'],
      ['Dex', 'Swap'],
      ['Abenteuer', 'Play']
    ]);
    expect(german.sections.map(section => [section.id, section.title])).toEqual([
      ['featured', 'Empfohlen'],
      ['tools', 'Tools'],
      ['more', 'More'],
      ['recents', 'Recents']
    ]);
  });

  it('keeps every other field of an item as the document gave it', () => {
    expect(view().items[1]).toEqual({
      id: 'dex',
      category: 'defi',
      name: 'Dex',
      tagline: 'Swap',
      url: 'https://dex.example',
      isExchange: true
    });
  });

  it('adds Recents under an id no document section may take', () => {
    const [recents] = localizeExploreCatalog(null, 'en', 'Recents').sections;
    expect(RESERVED_SECTION_IDS).toContain(recents?.id);
  });

  it('shows Recents alone on a network with no catalog', () => {
    expect(localizeExploreCatalog(null, 'en', 'Recents')).toEqual({
      items: [],
      sections: [{ id: 'recents', kind: 'recents', title: 'Recents' }]
    });
  });
});

describe('resolveExploreSections', () => {
  it('keeps document order, skips ids with no item, and shows Recents under All', () => {
    expect(resolveExploreSections(view(), 'all').map(r => r.section.id)).toEqual([
      'featured',
      'tools',
      'more',
      'recents'
    ]);
    // Without swap the gate drops the exchange item, and the sections naming it skip its id.
    mockSwapEnabled = false;
    const withoutSwap = localizeExploreCatalog(getExploreCatalog(catalog), 'en', 'Recents');
    expect(resolveExploreSections(withoutSwap, 'all')[1]?.items.map(i => i.id)).toEqual(['faucet']);
  });

  it('filters items to the category and drops sections left empty, and Recents', () => {
    const resolved = resolveExploreSections(view(), 'games');
    expect(resolved.map(r => r.section.id)).toEqual(['more']);
    expect(resolved[0]?.items.map(i => i.id)).toEqual(['quest']);
  });

  it('returns nothing for a category with no items', () => {
    expect(resolveExploreSections(view(), 'learn')).toEqual([]);
  });
});

describe('getExploreCatalog', () => {
  it('drops exchange items where swap is disabled', () => {
    mockSwapEnabled = false;
    expect(getExploreCatalog(catalog)?.items.map(i => i.id)).toEqual(['faucet', 'quest']);
  });

  it('keeps them elsewhere, by reference, and passes no catalog through', () => {
    expect(getExploreCatalog(catalog)).toBe(catalog);
    expect(getExploreCatalog(null)).toBeNull();
    mockSwapEnabled = false;
    expect(getExploreCatalog(null)).toBeNull();
  });
});

describe('searchExploreCatalog', () => {
  it('matches name, tagline or host on every word, ignoring case, each item once', () => {
    expect(searchExploreCatalog(view(), 'all', 'FAUCET').map(i => i.id)).toEqual(['faucet']);
    expect(searchExploreCatalog(view(), 'all', 'play').map(i => i.id)).toEqual(['quest']);
    expect(searchExploreCatalog(view(), 'all', 'dex.example').map(i => i.id)).toEqual(['dex']);
    expect(searchExploreCatalog(view(), 'all', 'quest play').map(i => i.id)).toEqual(['quest']);
    expect(searchExploreCatalog(view(), 'all', 'quest mint')).toEqual([]);
  });

  it('matches the text as drawn, not the English it stands in for', () => {
    expect(searchExploreCatalog(view('de'), 'all', 'prägen').map(i => i.id)).toEqual(['faucet']);
    expect(searchExploreCatalog(view('de'), 'all', 'mint')).toEqual([]);
  });

  it('stays within the chip, and matches nothing for an empty query', () => {
    expect(searchExploreCatalog(view(), 'games', 'faucet')).toEqual([]);
    expect(searchExploreCatalog(view(), 'all', '   ')).toEqual([]);
  });
});
