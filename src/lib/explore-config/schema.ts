import { isRecord } from 'lib/update/guards';

/** The categories a document item may name, one per category chip; an item in any other is left out. */
export const EXPLORE_CATEGORIES = ['tools', 'defi', 'games', 'nft', 'learn'] as const;
export type ExploreCategory = (typeof EXPLORE_CATEGORIES)[number];

/** The layouts a document section may name; a section of any other kind is left out. */
export const EXPLORE_SECTION_KINDS = ['featured', 'list'] as const;
export type ExploreCatalogSectionKind = (typeof EXPLORE_SECTION_KINDS)[number];

/** The ids of the sections the code adds itself (Recents, the search results); a document section may not take one. */
export const RESERVED_SECTION_IDS = ['recents', 'search-results'] as const;

/** The wallet's locale codes, as `public/_locales` names its directories. */
export const EXPLORE_LOCALES = [
  'de',
  'en',
  'en_GB',
  'es',
  'fr',
  'ja',
  'ko',
  'pl',
  'pt',
  'ru',
  'tr',
  'uk',
  'zh_CN',
  'zh_TW'
] as const;
export type ExploreLocale = (typeof EXPLORE_LOCALES)[number];

export const NAME_MAX_CHARS = 40;
export const TAGLINE_MAX_CHARS = 120;

/** Literal text by locale: `en` always, any other wallet locale optionally. */
export type LocalizedText = { readonly en: string } & Readonly<Partial<Record<ExploreLocale, string>>>;

export interface ExploreCatalogItem {
  id: string;
  name: LocalizedText;
  tagline: LocalizedText;
  /** Exactly as the document wrote it. */
  url: string;
  category: ExploreCategory;
  /** The bundled file for an icon this build ships, else the document's base URL and its `icons/<name>.png`. */
  icon?: string;
  /** `#RRGGBB`. */
  brandColor?: string;
  isExchange: boolean;
}

export interface ExploreCatalogSection {
  id: string;
  kind: ExploreCatalogSectionKind;
  title: LocalizedText;
  /** Each names an item of the catalog, once. */
  itemIds: string[];
}

export interface ExploreCatalog {
  network: string;
  version: number;
  items: ExploreCatalogItem[];
  sections: ExploreCatalogSection[];
}

export interface ExploreParseOptions {
  /** A document an E2E build serves itself: item URLs may be http on 127.0.0.1 or localhost. */
  allowLocalHttp?: boolean;
  /** The base the document was read from, which its icon paths are relative to. No trailing slash. */
  baseUrl: string;
  /** Icons this build ships, by path: such an icon is the bundled file, any other resolves against `baseUrl`. */
  bundledIcons?: Readonly<Record<string, string>>;
}

const ID = /^[a-z0-9-]+$/;
const ICON = /^icons\/[a-z0-9-]+\.png$/;
const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_HTTP_HOSTS = ['127.0.0.1', 'localhost'];

// Each check throws on a violation and parseExploreConfig catches once: one bad known field rejects the document.
const invalid = (): never => {
  throw new Error('invalid explore config');
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalid());

function identifier(value: unknown): string {
  return typeof value === 'string' && ID.test(value) ? value : invalid();
}

// A key that is no wallet locale is ignored, so a document can add a language before every wallet ships it.
function text(value: unknown, maxChars: number): LocalizedText {
  if (!isRecord(value)) return invalid();
  const kept: Partial<Record<ExploreLocale, string>> = {};
  for (const locale of EXPLORE_LOCALES) {
    const entry = value[locale];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.trim() === '' || Array.from(entry).length > maxChars) return invalid();
    kept[locale] = entry;
  }
  const { en } = kept;
  return en === undefined ? invalid() : { ...kept, en };
}

// An IP literal, a local name or a punycode label can pass for a host the user knows.
function isDisguisedHost(hostname: string): boolean {
  return (
    hostname.startsWith('[') ||
    IPV4.test(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.split('.').some(label => label.startsWith('xn--'))
  );
}

// Kept exactly as written: Recents match an opened app by the exact string.
function itemUrl(value: unknown, allowLocalHttp: boolean): string {
  if (typeof value !== 'string') return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.username || url.password) return invalid();
  if (allowLocalHttp && url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname)) return value;
  return url.protocol === 'https:' && !isDisguisedHost(url.hostname) ? value : invalid();
}

function optional<T>(value: unknown, check: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value);
}

const iconPath = (value: unknown): string => (typeof value === 'string' && ICON.test(value) ? value : invalid());
const brandColor = (value: unknown): string =>
  typeof value === 'string' && BRAND_COLOR.test(value) ? value : invalid();

// Every known field is checked before an unknown category leaves the item out.
function readItem(
  value: unknown,
  options: Required<ExploreParseOptions>
): { id: string; item: ExploreCatalogItem | null } {
  if (!isRecord(value)) return invalid();
  const id = identifier(value.id);
  const name = text(value.name, NAME_MAX_CHARS);
  const tagline = text(value.tagline, TAGLINE_MAX_CHARS);
  const url = itemUrl(value.url, options.allowLocalHttp);
  const icon = optional(value.icon, iconPath);
  const color = optional(value.brandColor, brandColor);
  const { category: named, isExchange } = value;
  if (typeof named !== 'string' || typeof isExchange !== 'boolean') return invalid();
  const category = EXPLORE_CATEGORIES.find(known => known === named);
  if (category === undefined) return { id, item: null };
  return {
    id,
    item: {
      id,
      name,
      tagline,
      url,
      category,
      isExchange,
      ...(icon === undefined ? {} : { icon: options.bundledIcons[icon] ?? `${options.baseUrl}/${icon}` }),
      ...(color === undefined ? {} : { brandColor: color })
    }
  };
}

function itemIdList(value: unknown, ids: ReadonlySet<string>): string[] {
  const listed = new Set<string>();
  for (const entry of list(value)) {
    if (typeof entry !== 'string' || !ids.has(entry) || listed.has(entry)) return invalid();
    listed.add(entry);
  }
  return [...listed];
}

function readSection(value: unknown, ids: ReadonlySet<string>): { id: string; section: ExploreCatalogSection | null } {
  if (!isRecord(value)) return invalid();
  const id = identifier(value.id);
  if (RESERVED_SECTION_IDS.some(reserved => reserved === id)) return invalid();
  const { kind: named } = value;
  if (typeof named !== 'string') return invalid();
  const title = text(value.title, Number.POSITIVE_INFINITY);
  const itemIds = itemIdList(value.itemIds, ids);
  const kind = EXPLORE_SECTION_KINDS.find(known => known === named);
  return { id, section: kind === undefined ? null : { id, kind, title, itemIds } };
}

function unique(id: string, seen: Set<string>): void {
  if (seen.has(id)) invalid();
  seen.add(id);
}

function readCatalog(body: unknown, network: string, options: Required<ExploreParseOptions>): ExploreCatalog {
  if (!isRecord(body)) return invalid();
  const { version } = body;
  if (body.network !== network || !isPositiveSafeInteger(version)) return invalid();
  const itemEntries = list(body.items);
  const sectionEntries = list(body.sections);
  const ids = new Set<string>();
  const items: ExploreCatalogItem[] = [];
  for (const entry of itemEntries) {
    const { id, item } = readItem(entry, options);
    unique(id, ids);
    if (item) items.push(item);
  }
  // An item left out leaves every section with it.
  const kept = new Set(items.map(item => item.id));
  const sectionIds = new Set<string>();
  const sections: ExploreCatalogSection[] = [];
  for (const entry of sectionEntries) {
    const { id, section } = readSection(entry, ids);
    unique(id, sectionIds);
    if (section) sections.push({ ...section, itemIds: section.itemIds.filter(itemId => kept.has(itemId)) });
  }
  return { network, version, items, sections };
}

/**
 * The Explore catalog for `network`, or null when the document is malformed or names another network. Strict on known
 * fields, blind to unknown ones; an item in an unknown category or a section of an unknown kind is left out. Mirrored
 * rule for rule by 0xMiden/wallet-explore's scripts/validate.mjs.
 */
export function parseExploreConfig(
  body: unknown,
  network: string,
  options: ExploreParseOptions
): ExploreCatalog | null {
  try {
    return readCatalog(body, network, {
      allowLocalHttp: options.allowLocalHttp === true,
      baseUrl: options.baseUrl,
      bundledIcons: options.bundledIcons ?? {}
    });
  } catch {
    return null;
  }
}

function inLocale(text: LocalizedText, code: string): string | undefined {
  const locale = EXPLORE_LOCALES.find(known => known === code);
  return locale === undefined ? undefined : text[locale];
}

/**
 * `text` in `locale`, a wallet code (`zh_TW`) or an i18next one (`zh-TW`): that locale, else its base language, else
 * English.
 */
export function localizedText(text: LocalizedText, locale: string): string {
  const code = locale.replace(/-/g, '_');
  const [base = code] = code.split('_');
  return inLocale(text, code) ?? inLocale(text, base) ?? text.en;
}
