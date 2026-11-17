// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/{cctp-schema,circle-api.server}.ts (MIT).
import { isAddress, isHex, type Address, type Hex } from 'viem';

export type CctpQuoteExpiry =
  | { mode: 'TIMESTAMP'; expiresAt: number }
  | { mode: 'BLOCK_NUMBER'; expiresAtBlock: number; blockEstimatedAt?: number };

export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}
export function unsignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 78 && /^\d+$/.test(value);
}
function unsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function signedQuoteHex(value: unknown): value is Hex {
  return typeof value === 'string' && value.length <= 16384 && /^0x(?:[\da-f]{2})+$/i.test(value) && isHex(value);
}
export function parseCctpExpiry(value: unknown): CctpQuoteExpiry {
  const mode = field(value, 'mode');
  const expiresAt = field(value, 'expiresAt');
  const expiresAtBlock = field(value, 'expiresAtBlock');
  const blockEstimatedAt = field(value, 'blockEstimatedAt');
  if (mode === 'TIMESTAMP' && unsignedInteger(expiresAt) && expiresAt > 0 && expiresAt <= Number.MAX_SAFE_INTEGER / 1000)
    return { mode, expiresAt };
  if (mode === 'BLOCK_NUMBER' && unsignedInteger(expiresAtBlock) && expiresAtBlock > 0 &&
      (blockEstimatedAt === undefined || unsignedInteger(blockEstimatedAt)))
    return { mode, expiresAtBlock, ...(blockEstimatedAt !== undefined && { blockEstimatedAt }) };
  throw new Error('Circle returned invalid quote expiry');
}

export function parseCircleValidation(body: unknown, quote: { signedQuote: Hex; feeTotalAmount: bigint }, token: Address): number {
  const expiry = field(body, 'expiry');
  parseCctpExpiry(expiry);
  const seconds = field(expiry, 'secondsRemaining');
  const items = field(body, 'items');
  const failed = field(body, 'failedChecks');
  const signature = field(body, 'signedQuote');
  const feeToken = field(body, 'feeToken');
  const fee = field(body, 'feeTotalAmount');
  if (!signedQuoteHex(signature) || signature.toLowerCase() !== quote.signedQuote.toLowerCase() ||
      typeof feeToken !== 'string' || !isAddress(feeToken) || feeToken.toLowerCase() !== token.toLowerCase() ||
      !unsignedDecimal(fee) || BigInt(fee) !== quote.feeTotalAmount || field(body, 'nonce') !== '0' ||
      field(body, 'claimable') !== true || field(expiry, 'expired') !== false ||
      !unsignedInteger(seconds) || !Array.isArray(failed) || failed.length !== 0 ||
      !Array.isArray(items) || items.length !== 2 || !items.every(item => field(item, 'argsMatch') === true) ||
      !items.some(item => field(item, 'type') === 'FORWARD') || !items.some(item => field(item, 'type') === 'PRE_FINALITY'))
    throw new Error('Circle rejected the reviewed burn authorization');
  return seconds;
}

export function parseCircleQuote(body: unknown, amount: bigint, token: Address) {
  const signedQuote = field(body, 'signedQuote');
  const feeTotalAmount = field(body, 'feeTotalAmount');
  const burnAmount = field(body, 'burnAmount');
  const feeToken = field(body, 'feeToken');
  const issuedAt = field(body, 'issuedAt');
  if (!signedQuoteHex(signedQuote) || !unsignedDecimal(feeTotalAmount))
    throw new Error('Circle quote response is missing the signed quote or the fee');
  if (!unsignedDecimal(burnAmount) || BigInt(burnAmount) !== amount || typeof feeToken !== 'string' || !isAddress(feeToken) ||
      feeToken.toLowerCase() !== token.toLowerCase())
    throw new Error('Circle quote amount or token changed');
  const expiry = parseCctpExpiry(field(body, 'expiry'));
  if (!unsignedInteger(issuedAt) || issuedAt === 0 ||
      (expiry.mode === 'TIMESTAMP' && expiry.expiresAt <= issuedAt))
    throw new Error('Circle returned invalid quote issuance');
  return { signedQuote, feeTotalAmount: BigInt(feeTotalAmount), issuedAt, expiry,
    expiresAt: expiry.mode === 'TIMESTAMP' ? expiry.expiresAt : undefined };
}
