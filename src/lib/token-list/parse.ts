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
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isToken = (value: unknown): value is { network: string; faucetId: string; logoURI?: unknown } =>
  isRecord(value) && isNonEmptyString(value.network) && isNonEmptyString(value.faucetId);

const LOGO_PREFIX = 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/';

/**
 * Read faucet ids, logos and price assets for one network.
 * Reject the full document when a token has no network or faucet id.
 * Ignore invalid logos and price assets without removing the verified id.
 */
export function parseTokenList(value: unknown, network: string): TokenList | null {
  if (!isRecord(value)) return null;
  const { tokens } = value;
  if (!Array.isArray(tokens) || !tokens.every(isToken)) return null;
  const ids = new Set<string>();
  const logos = new Map<string, string>();
  const priceAssets = new Map<string, string>();
  const faucetsBySymbol = new Map<string, string>();
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
      if (typeof asset === 'string' && /^[A-Z0-9]{1,20}$/.test(asset)) priceAssets.set(faucetId, asset);
      if (typeof symbol === 'string' && symbol.length > 0) {
        if (faucetsBySymbol.has(symbol)) sharedSymbols.add(symbol);
        faucetsBySymbol.set(symbol, faucetId);
      }
    }
    const own = `${LOGO_PREFIX}${faucetId}/logo.`;
    if (logoURI === `${own}png`) logos.set(faucetId, logoURI);
  }
  sharedSymbols.forEach(symbol => faucetsBySymbol.delete(symbol));
  return { ids, logos, priceAssets, faucetsBySymbol };
}
