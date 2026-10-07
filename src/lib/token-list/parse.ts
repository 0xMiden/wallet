import { isRecord } from 'lib/update/guards';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isToken = (value: unknown): value is { network: string; faucetId: string } =>
  isRecord(value) && isNonEmptyString(value.network) && isNonEmptyString(value.faucetId);

/**
 * The verified faucet ids a token-list document names for `network`, as the document spells them,
 * or `null` when the document is malformed. Only each token's network and faucet
 * id are checked, since nothing else is read (the token-list repository's CI validates the full
 * schema). One bad token rejects the whole document: a partial list would mark the holders of the
 * dropped token Unverified.
 */
export function parseTokenList(value: unknown, network: string): Set<string> | null {
  if (!isRecord(value)) return null;
  const { tokens } = value;
  if (!Array.isArray(tokens) || !tokens.every(isToken)) return null;
  return new Set(tokens.filter(token => token.network === network).map(token => token.faucetId));
}

const LOGO_PREFIX = 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/';

/**
 * The logo of each listed token on `network`, by faucet id as the list spells it. A logo counts only
 * as the list repository's own file for that token's id; anything else drops that logo and nothing
 * else, since a logo never decides whether a token is verified. Read only from a document
 * `parseTokenList` accepted.
 */
export function parseTokenLogos(value: unknown, network: string): Map<string, string> {
  const logos = new Map<string, string>();
  if (parseTokenList(value, network) === null || !isRecord(value) || !Array.isArray(value.tokens)) return logos;
  for (const entry of value.tokens) {
    if (!isRecord(entry) || entry.network !== network) continue;
    const { faucetId, logoURI } = entry;
    if (!isNonEmptyString(faucetId)) continue;
    const own = `${LOGO_PREFIX}${faucetId}/logo.`;
    if (logoURI === `${own}svg` || logoURI === `${own}png`) logos.set(faucetId, logoURI);
  }
  return logos;
}
