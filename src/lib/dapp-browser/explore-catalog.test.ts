import {
  EXPLORE_CATALOG,
  EXPLORE_FILTERS,
  getExploreCatalog,
  resolveExploreSections,
  searchExploreCatalog,
  type ExploreCatalog
} from './explore-catalog';

const mockSwapEnabled = { value: true };
jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled.value
}));

const catalog: ExploreCatalog = {
  items: [
    { id: 'faucet', category: 'tools', name: 'Faucet', tagline: 'Mint', url: 'https://faucet.example' },
    {
      id: 'dex',
      category: 'defi',
      name: 'Dex',
      tagline: 'Swap',
      url: 'https://dex.example',
      isExchange: true
    },
    { id: 'quest', category: 'games', name: 'Quest', tagline: 'Play', url: 'https://quest.example' }
  ],
  sections: [
    { id: 'featured', kind: 'featured', titleKey: 'exploreFeatured', itemIds: ['faucet'] },
    { id: 'tools', kind: 'list', titleKey: 'exploreHelperTools', itemIds: ['faucet', 'missing'] },
    { id: 'more', kind: 'list', titleKey: 'more', itemIds: ['dex', 'quest'] },
    { id: 'recents', kind: 'recents', titleKey: 'recents' }
  ]
};

beforeEach(() => {
  mockSwapEnabled.value = true;
});

describe('EXPLORE_CATALOG', () => {
  it('features the Faucet and lists both faucets as helper tools, then recents', () => {
    expect(EXPLORE_CATALOG.sections.map(s => s.kind)).toEqual(['featured', 'list', 'recents']);
    const ids = new Set(EXPLORE_CATALOG.items.map(item => item.id));
    expect(ids).toEqual(new Set(['faucet', 'forkchoice-faucet']));
    for (const section of EXPLORE_CATALOG.sections) {
      if (section.kind === 'recents') continue;
      section.itemIds.forEach(id => expect(ids.has(id)).toBe(true));
    }
  });

  it('offers All first, then every category', () => {
    expect(EXPLORE_FILTERS.map(f => f.id)).toEqual(['all', 'tools', 'defi', 'games', 'nft', 'learn']);
  });
});

describe('resolveExploreSections', () => {
  it('keeps config order, drops unknown ids, and shows recents under All', () => {
    const resolved = resolveExploreSections(catalog, 'all');
    expect(resolved.map(r => r.section.id)).toEqual(['featured', 'tools', 'more', 'recents']);
    expect(resolved[1]?.items.map(i => i.id)).toEqual(['faucet']);
  });

  it('filters items to the category and drops sections left empty, and recents', () => {
    const resolved = resolveExploreSections(catalog, 'games');
    expect(resolved.map(r => r.section.id)).toEqual(['more']);
    expect(resolved[0]?.items.map(i => i.id)).toEqual(['quest']);
  });

  it('returns nothing for a category with no items', () => {
    expect(resolveExploreSections(catalog, 'learn')).toEqual([]);
  });
});

describe('getExploreCatalog', () => {
  it('drops exchange items where swap is disabled (iOS)', () => {
    mockSwapEnabled.value = false;
    expect(getExploreCatalog(catalog).items.map(i => i.id)).toEqual(['faucet', 'quest']);
  });

  it('keeps them elsewhere', () => {
    expect(getExploreCatalog(catalog)).toBe(catalog);
  });
});

describe('the Forkchoice Faucet', () => {
  it('keeps its name and is worded as the swap faucet, through an i18n key', () => {
    const forkchoice = EXPLORE_CATALOG.items.find(item => item.id === 'forkchoice-faucet');
    expect(forkchoice).toMatchObject({
      name: 'Forkchoice Faucet',
      tagline: 'Get testnet tokens for swap',
      taglineKey: 'exploreForkchoiceFaucetTagline'
    });
  });
});

describe('searchExploreCatalog', () => {
  it('matches name, tagline or host on every word, ignoring case, each item once', () => {
    expect(searchExploreCatalog(catalog, 'all', 'FAUCET').map(i => i.id)).toEqual(['faucet']);
    expect(searchExploreCatalog(catalog, 'all', 'play').map(i => i.id)).toEqual(['quest']);
    expect(searchExploreCatalog(catalog, 'all', 'dex.example').map(i => i.id)).toEqual(['dex']);
    expect(searchExploreCatalog(catalog, 'all', 'quest play').map(i => i.id)).toEqual(['quest']);
    expect(searchExploreCatalog(catalog, 'all', 'quest mint')).toEqual([]);
  });

  it('stays within the chip, and matches nothing for an empty query', () => {
    expect(searchExploreCatalog(catalog, 'games', 'faucet')).toEqual([]);
    expect(searchExploreCatalog(catalog, 'all', '   ')).toEqual([]);
  });
});
