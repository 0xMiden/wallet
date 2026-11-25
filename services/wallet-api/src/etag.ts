import { sha256Hex } from './encoding';
import type { MetadataRow, ProfileMetadataRow } from './rows';

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The feature ETag: SHA-256 of salt_hex, a newline, and the lines "hashed_key:revision" sorted by key.
 * @param saltHex Empty while the salt is NULL.
 */
export function featureEtag(saltHex: string, rows: readonly MetadataRow[]): Promise<string> {
  const lines = [...rows]
    .sort((left, right) => compareStrings(left.hashedKey, right.hashedKey))
    .map(row => `${row.hashedKey}:${row.revision}`);
  return sha256Hex(`${saltHex}\n${lines.join('\n')}`);
}

/** The full-profile ETag: lines "feature:hashed_key:revision" sorted by feature, then by key. */
export function profileEtag(saltHex: string, rows: readonly ProfileMetadataRow[]): Promise<string> {
  const lines = [...rows]
    .sort((left, right) => compareStrings(left.feature, right.feature) || compareStrings(left.hashedKey, right.hashedKey))
    .map(row => `${row.feature}:${row.hashedKey}:${row.revision}`);
  return sha256Hex(`${saltHex}\n${lines.join('\n')}`);
}
