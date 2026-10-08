import fs from 'fs';
import path from 'path';

import {
  EXPLORE_CATEGORIES,
  EXPLORE_LOCALES,
  EXPLORE_SECTION_KINDS,
  localizedText,
  parseExploreConfig,
  RESERVED_SECTION_IDS
} from './schema';

const BASE = 'https://cdn.example/explore';

const item = (fields: Record<string, unknown> = {}) => ({
  id: 'faucet',
  name: { en: 'Faucet' },
  tagline: { en: 'Get testnet tokens' },
  url: 'https://faucet.testnet.miden.io/',
  category: 'tools',
  icon: 'icons/faucet.png',
  brandColor: '#778C72',
  isExchange: false,
  ...fields
});
const section = (fields: Record<string, unknown> = {}) => ({
  id: 'featured',
  kind: 'featured',
  title: { en: 'Featured' },
  itemIds: ['faucet'],
  ...fields
});
const doc = (fields: Record<string, unknown> = {}) => ({
  network: 'testnet',
  version: 1,
  items: [item()],
  sections: [section()],
  ...fields
});
const withItem = (fields: Record<string, unknown>) => doc({ items: [item(fields)] });
const withSection = (fields: Record<string, unknown>) => doc({ sections: [section(fields)] });
const parse = (body: unknown, allowLocalHttp = false) =>
  parseExploreConfig(body, 'testnet', { allowLocalHttp, baseUrl: BASE });

it('parses a document, resolving each icon against its base and keeping each url as written', () => {
  expect(parse(doc())).toStrictEqual({
    network: 'testnet',
    version: 1,
    items: [
      {
        id: 'faucet',
        name: { en: 'Faucet' },
        tagline: { en: 'Get testnet tokens' },
        url: 'https://faucet.testnet.miden.io/',
        category: 'tools',
        icon: `${BASE}/icons/faucet.png`,
        brandColor: '#778C72',
        isExchange: false
      }
    ],
    sections: [{ id: 'featured', kind: 'featured', title: { en: 'Featured' }, itemIds: ['faucet'] }]
  });
});

it('resolves an icon this build ships to its bundled file, and any other icon against the base', () => {
  const catalog = parseExploreConfig(
    doc({ items: [item(), item({ id: 'quest', icon: 'icons/quest.png' })], sections: [] }),
    'testnet',
    { baseUrl: BASE, bundledIcons: { 'icons/faucet.png': '/assets/faucet-1a2b.png' } }
  );
  expect(catalog?.items.map(entry => entry.icon)).toEqual(['/assets/faucet-1a2b.png', `${BASE}/icons/quest.png`]);
});

it.each([
  ['a body that is not an object', 'testnet'],
  ['another network', doc({ network: 'devnet' })],
  ['a version of 0', doc({ version: 0 })],
  ['a fractional version', doc({ version: 1.5 })],
  ['a version given as text', doc({ version: '1' })],
  ['no items list', doc({ items: undefined, sections: [] })],
  ['sections given as an object', doc({ sections: {} })],
  ['an item that is not an object', doc({ items: ['faucet'], sections: [] })],
  ['an id with capitals', doc({ items: [item({ id: 'Faucet' })], sections: [] })],
  ['an item id listed twice', doc({ items: [item(), item()] })],
  ['a section id listed twice', doc({ sections: [section(), section({ kind: 'list' })] })],
  ['a section taking the id of Recents', withSection({ id: 'recents' })],
  ['a section taking the id of the search results', withSection({ id: 'search-results' })],
  ['a name given as an i18n key', withItem({ name: 'exploreFaucet' })],
  ['a name with no English', withItem({ name: { de: 'Faucet' } })],
  ['a blank name', withItem({ name: { en: ' ' } })],
  ['a translated name that is not text', withItem({ name: { en: 'Faucet', de: 3 } })],
  ['a name over 40 characters', withItem({ name: { en: 'x'.repeat(41) } })],
  ['a translated tagline over 120 characters', withItem({ tagline: { en: 'Get tokens', fr: 'x'.repeat(121) } })],
  ['a section title given as an i18n key', withSection({ title: 'exploreFeatured' })],
  ['a url that is not text', withItem({ url: 3 })],
  ['a url that does not parse', withItem({ url: 'faucet.example' })],
  ['a url with credentials', withItem({ url: 'https://user:pass@faucet.example/' })],
  ['an http url', withItem({ url: 'http://faucet.example/' })],
  ['a local http url outside an E2E build', withItem({ url: 'http://127.0.0.1:4173/' })],
  ['an IPv4 host', withItem({ url: 'https://127.0.0.1/' })],
  ['an IPv4 host written as one number', withItem({ url: 'https://2130706433/' })],
  ['an IPv6 host', withItem({ url: 'https://[::1]/' })],
  ['localhost', withItem({ url: 'https://localhost:8080/' })],
  ['a subdomain of localhost', withItem({ url: 'https://app.localhost/' })],
  ['localhost written with a trailing dot', withItem({ url: 'https://localhost./' })],
  ['a subdomain of localhost written with a trailing dot', withItem({ url: 'https://app.localhost./' })],
  ['a punycode host', withItem({ url: 'https://xn--fucet-gra.example/' })],
  ['a Unicode host, which reads as punycode', withItem({ url: 'https://fäucet.example/' })],
  ['a category that is not text', withItem({ category: 7 })],
  ['an icon outside icons/', withItem({ icon: 'faucet.png' })],
  ['an icon that is not a png', withItem({ icon: 'icons/faucet.svg' })],
  ['an icon of null', withItem({ icon: null })],
  ['a three-digit brand color', withItem({ brandColor: '#778' })],
  ['no isExchange', withItem({ isExchange: undefined })],
  ['an isExchange given as text', withItem({ isExchange: 'false' })],
  ['a section that is not an object', doc({ sections: ['featured'] })],
  ['a section kind that is not text', withSection({ kind: 1 })],
  ['section itemIds that are not a list', withSection({ itemIds: 'faucet' })],
  ['a section naming no item', withSection({ itemIds: ['missing'] })],
  ['a section naming an item twice', withSection({ itemIds: ['faucet', 'faucet'] })],
  ['an itemIds entry that is not text', withSection({ itemIds: [1] })]
])('refuses %s', (_label, body) => {
  expect(parse(body)).toBeNull();
});

it('leaves out an item in a category this build does not know, from the items and every section', () => {
  const catalog = parse(
    doc({
      items: [item(), item({ id: 'quest', category: 'quests' })],
      sections: [section({ itemIds: ['quest', 'faucet'] }), section({ id: 'more', kind: 'list', itemIds: ['quest'] })]
    })
  );
  expect(catalog?.items.map(entry => entry.id)).toEqual(['faucet']);
  expect(catalog?.sections.map(entry => entry.itemIds)).toEqual([['faucet'], []]);
});

it('leaves out a section of a kind this build does not know', () => {
  const catalog = parse(doc({ sections: [section({ kind: 'carousel' }), section({ id: 'tools', kind: 'list' })] }));
  expect(catalog?.sections.map(entry => entry.id)).toEqual(['tools']);
});

it('still refuses a left-out item or section whose known fields are malformed', () => {
  expect(
    parse(doc({ items: [item(), item({ id: 'quest', category: 'quests', url: 'http://quest.example/' })] }))
  ).toBeNull();
  expect(parse(withSection({ kind: 'carousel', itemIds: ['missing'] }))).toBeNull();
});

it('ignores fields and locales it does not know, so a newer document still reads', () => {
  const catalog = parse(
    doc({
      art: 'icons/art.png',
      items: [item({ rating: 5, name: { en: 'Faucet', it: 'Rubinetto', de: 'Faucet' } })],
      sections: [section({ subtitle: { en: 'New' } })]
    })
  );
  expect(catalog?.items[0]?.name).toStrictEqual({ en: 'Faucet', de: 'Faucet' });
  expect(catalog?.sections).toStrictEqual([
    { id: 'featured', kind: 'featured', title: { en: 'Featured' }, itemIds: ['faucet'] }
  ]);
});

it('counts the name and tagline caps in characters, not bytes or UTF-16 units', () => {
  const name = '水'.repeat(40);
  const tagline = '🚰'.repeat(120);
  expect(parse(withItem({ name: { en: name }, tagline: { en: tagline } }))?.items[0]).toMatchObject({
    name: { en: name },
    tagline: { en: tagline }
  });
});

it('keeps an icon and a brand color optional, and a url with a query and fragment as written', () => {
  const url = 'https://Faucet.Example/claim?ref=wallet#top';
  expect(parse(withItem({ icon: undefined, brandColor: undefined, url }))?.items[0]).toStrictEqual({
    id: 'faucet',
    name: { en: 'Faucet' },
    tagline: { en: 'Get testnet tokens' },
    url,
    category: 'tools',
    isExchange: false
  });
});

it('accepts local http item urls only in a document an E2E build serves itself', () => {
  const local = doc({
    items: [item({ url: 'http://127.0.0.1:4173/app' }), item({ id: 'other', url: 'http://localhost:4173/' })],
    sections: []
  });
  expect(parse(local)).toBeNull();
  expect(parse(local, true)?.items.map(entry => entry.url)).toEqual([
    'http://127.0.0.1:4173/app',
    'http://localhost:4173/'
  ]);
  expect(parse(withItem({ url: 'http://faucet.example/' }), true)).toBeNull();
  expect(parse(withItem({ url: 'http://user@127.0.0.1:4173/' }), true)).toBeNull();
});

describe('localizedText', () => {
  const text = { en: 'Featured', en_GB: 'Featured (GB)', de: 'Empfohlen', zh_TW: '精選', pt: 'Destaque' };

  it.each([
    ['a wallet code', 'zh_TW', '精選'],
    ['an i18next code', 'zh-TW', '精選'],
    ['a regional code it has', 'en-GB', 'Featured (GB)'],
    ['a region it lacks, by its base language', 'de-DE', 'Empfohlen'],
    ['Brazilian Portuguese, by its base language', 'pt-BR', 'Destaque'],
    ['Simplified Chinese where only Traditional is given, in English', 'zh-CN', 'Featured'],
    ['a language it lacks, in English', 'fr', 'Featured'],
    ['a code that is no wallet locale, in English', 'xx-YY', 'Featured']
  ])('reads %s', (_label, locale, expected) => {
    expect(localizedText(text, locale)).toBe(expected);
  });
});

it('gives a text locale to every locale the wallet ships', () => {
  const shipped = fs
    .readdirSync(path.join(__dirname, '../../../public/_locales'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  expect([...EXPLORE_LOCALES].sort()).toEqual(shipped);
});

it('knows the categories the chips draw and the two document layouts', () => {
  expect(EXPLORE_CATEGORIES).toEqual(['tools', 'defi', 'games', 'nft', 'learn']);
  expect(EXPLORE_SECTION_KINDS).toEqual(['featured', 'list']);
  expect(RESERVED_SECTION_IDS).toEqual(['recents', 'search-results']);
});
