import { isRecord } from 'lib/update/guards';

/**
 * What a token-list document says about one network, by faucet id as the document spells it. `faucetsBySymbol` maps
 * each symbol the list gives exactly one token to that token's faucet id.
 */
export type TokenList = {
  ids: Set<string>;
  logos: Map<string, string>;
  priceAssets: Map<string, string>;
  faucetsBySymbol: Map<string, string>;
  /**
   * The constituents (`basket.constituents`) of each basket token: a token whose faucet account is the public vault
   * that backs it. Kept only when the basket and every constituent have a price asset, every constituent is listed, is
   * not the basket and is not itself a basket.
   */
  baskets: Map<string, string[]>;
  /** Each token's decimals as the list writes them. */
  decimals: Map<string, number>;
  /** Each token's symbol as the list writes it, so a token the user does not hold can still be named. */
  symbols: Map<string, string>;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isToken = (value: unknown): value is { network: string; faucetId: string; logoURI?: unknown } =>
  isRecord(value) && isNonEmptyString(value.network) && isNonEmptyString(value.faucetId);

const LOGO_PREFIX = 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/';

const MAX_BASKET_CONSTITUENTS = 12;

/** A basket's constituents: 1 to 12 distinct non-empty faucet ids, else none. */
function readConstituents(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.constituents)) return undefined;
  const { constituents } = value;
  if (constituents.length === 0 || constituents.length > MAX_BASKET_CONSTITUENTS) return undefined;
  if (!constituents.every(isNonEmptyString) || new Set(constituents).size !== constituents.length) return undefined;
  return constituents;
}

/**
 * Read faucet ids, logos, price assets, decimals and baskets for one network.
 * Reject the full document when a token has no network or faucet id.
 * Ignore invalid logos, price assets, decimals and baskets without removing the verified id.
 */
export function parseTokenList(value: unknown, network: string): TokenList | null {
  if (!isRecord(value)) return null;
  const { tokens } = value;
  if (!Array.isArray(tokens) || !tokens.every(isToken)) return null;
  const ids = new Set<string>();
  const logos = new Map<string, string>();
  const priceAssets = new Map<string, string>();
  const faucetsBySymbol = new Map<string, string>();
  const decimals = new Map<string, number>();
  const symbols = new Map<string, string>();
  const declaredBaskets = new Map<string, string[]>();
  // A symbol two tokens share names neither: which one it means is not the list's to say.
  const sharedSymbols = new Set<string>();
  for (const token of tokens) {
    const { network: tokenNetwork, faucetId, logoURI } = token;
    if (tokenNetwork !== network) continue;
    ids.add(faucetId);
    if (isRecord(token)) {
      const symbol = 'symbol' in token ? token.symbol : undefined;
      let asset = symbol;
      if ('binanceAsset' in token && token.binanceAsset !== undefined) asset = token.binanceAsset;
      if (typeof asset === 'string' && /^[A-Z0-9]{1,20}$/.test(asset)) {
        priceAssets.set(faucetId, asset);
      }
      const places = 'decimals' in token ? token.decimals : undefined;
      if (typeof places === 'number' && Number.isInteger(places) && places >= 0 && places <= 18) {
        decimals.set(faucetId, places);
      }
      const constituents = 'basket' in token ? readConstituents(token.basket) : undefined;
      if (constituents !== undefined) declaredBaskets.set(faucetId, constituents);
      if (typeof symbol === 'string' && symbol.length > 0) {
        if (/^[A-Za-z0-9.]{1,20}$/.test(symbol)) symbols.set(faucetId, symbol);
        if (faucetsBySymbol.has(symbol)) sharedSymbols.add(symbol);
        faucetsBySymbol.set(symbol, faucetId);
      }
    }
    const own = `${LOGO_PREFIX}${faucetId}/logo.`;
    if (logoURI === `${own}png`) logos.set(faucetId, logoURI);
  }
  sharedSymbols.forEach(symbol => faucetsBySymbol.delete(symbol));
  // A basket is priced from its constituents' prices and decimals, under its own price asset, so all of them must be
  // known. Checked once the whole list is read, since a constituent may come after its basket.
  const priced = (id: string) => priceAssets.has(id) && decimals.has(id);
  const baskets = new Map<string, string[]>();
  for (const [faucetId, constituents] of declaredBaskets) {
    const usable = constituents.every(id => id !== faucetId && priced(id) && !declaredBaskets.has(id));
    if (usable && priced(faucetId)) baskets.set(faucetId, constituents);
  }
  return { ids, logos, priceAssets, faucetsBySymbol, baskets, decimals, symbols };
}
