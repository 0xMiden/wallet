import { normalizedFaucetId } from 'lib/miden/swap/tokens';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isVersion = (value: unknown): boolean =>
  isRecord(value) && [value.major, value.minor, value.patch].every(part => Number.isInteger(part));

const isToken = (value: unknown): value is { network: string; faucetId: string } =>
  isRecord(value) &&
  isNonEmptyString(value.network) &&
  isNonEmptyString(value.faucetId) &&
  isNonEmptyString(value.symbol) &&
  isNonEmptyString(value.name) &&
  Number.isInteger(value.decimals) &&
  typeof value.decimals === 'number' &&
  value.decimals >= 0 &&
  value.decimals <= 18;

/**
 * The verified faucet ids a token-list document names for `network`, normalized to the balance
 * store's encoding, or `null` when the document is malformed. One bad token rejects the whole
 * document: a partial list would mark the holders of the dropped token Unverified.
 */
export function parseTokenList(value: unknown, network: string): Set<string> | null {
  if (!isRecord(value) || !isNonEmptyString(value.name) || !isVersion(value.version)) return null;
  const { tokens } = value;
  if (!Array.isArray(tokens) || !tokens.every(isToken)) return null;
  return new Set(tokens.filter(token => token.network === network).map(token => normalizedFaucetId(token.faucetId)));
}
