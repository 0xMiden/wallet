import { isRecord } from 'lib/update/guards';

/** What a token-list document says about one network, by faucet id as the document spells it. */
export type TokenList = { ids: Set<string>; logos: Map<string, string> };

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isToken = (value: unknown): value is { network: string; faucetId: string; logoURI?: unknown } =>
  isRecord(value) && isNonEmptyString(value.network) && isNonEmptyString(value.faucetId);

const LOGO_PREFIX = 'https://raw.githubusercontent.com/0xMiden/token-list/main/logos/';

/**
 * The verified faucet ids a token-list document names for `network` and the logos it gives them, or
 * `null` when the document is malformed. Only each token's network and faucet id are checked, since
 * only they decide anything (the token-list repository's CI validates the full schema). One bad token
 * rejects the whole document: a partial list would mark the holders of the dropped token Unverified.
 * A logo counts only as the list repository's own file for that token's id; anything else drops that
 * logo and nothing else, since a logo never decides whether a token is verified.
 */
export function parseTokenList(value: unknown, network: string): TokenList | null {
  if (!isRecord(value)) return null;
  const { tokens } = value;
  if (!Array.isArray(tokens) || !tokens.every(isToken)) return null;
  const ids = new Set<string>();
  const logos = new Map<string, string>();
  for (const { network: tokenNetwork, faucetId, logoURI } of tokens) {
    if (tokenNetwork !== network) continue;
    ids.add(faucetId);
    const own = `${LOGO_PREFIX}${faucetId}/logo.`;
    if (logoURI === `${own}svg` || logoURI === `${own}png`) logos.set(faucetId, logoURI);
  }
  return { ids, logos };
}
