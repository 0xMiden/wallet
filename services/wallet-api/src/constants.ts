// Limits and formats of the wallet-api contract.
import type { Feature } from './types';

export const FEATURES: readonly Feature[] = ['accounts', 'contacts', 'history'];
export const BLOB_CAP_BYTES: Readonly<Record<Feature, number>> = { accounts: 4096, contacts: 4096, history: 25_600 };
export const MIN_BLOB_BYTES = 12 + 16;
export const MAX_ENTRIES_PER_FEATURE = 1000;
export const MAX_BATCH_ENTRIES = 100;
/** The most entries one feature read returns. A read of more entries continues with `after`. */
export const MAX_PAGE_ENTRIES = 100;
export const MAX_BODY_BYTES = 512 * 1024;
export const NONCE_TTL_MS = 300_000;
export const TOKEN_TTL_S = 3600;
export const ENVELOPE_VERSION = 1;
export const KDF_SCRYPT = 0;
export const RESERVED_KDF_BITS_FROM = 2 ** 21;
export const MIN_SIGNING_KEY_LENGTH = 32;
export const RATE_LIMIT_RETRY_S = '60';
/** A batch write of this many entries costs one unit of the storage rate limit. */
export const WRITE_RATE_LIMIT_UNIT_ENTRIES = 10;

export const HEX64 = /^[0-9a-f]{64}$/;
export const PUBLIC_KEY = /^0[23][0-9a-f]{64}$/;
export const SIGNATURE = /^[0-9a-f]{128}$/;
export const SALT = /^[0-9a-f]{32}$/;
/** The profile generation: 16 bytes in lowercase hex. */
export const GENERATION = /^[0-9a-f]{32}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LOGIN_MESSAGE = /^miden-sync:login:([0-9a-f]{64}):(0[23][0-9a-f]{64})$/;
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const DECIMAL = /^(0|[1-9][0-9]{0,15})$/;

/** True for a JSON object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFeature(value: string): value is Feature {
  switch (value) {
    case 'accounts':
    case 'contacts':
    case 'history':
      return true;
    default:
      return false;
  }
}
