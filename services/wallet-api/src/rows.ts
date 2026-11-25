// Narrow D1 rows from unknown to the row types. A row of another shape is a server fault.
import { isFeature, isRecord } from './constants';
import { bytesToHex, toBytes } from './encoding';
import type { Feature } from './types';

export interface SaltRow {
  salt: Uint8Array | null;
}

/** The salt and the generation of a profile. */
export interface ProfileStateRow extends SaltRow {
  generation: Uint8Array;
}

export interface ProfileRow extends ProfileStateRow {
  syncPublicKey: Uint8Array;
}

export interface MetadataRow {
  hashedKey: string;
  revision: number;
}

export interface ProfileMetadataRow extends MetadataRow {
  feature: Feature;
}

export interface EntryRow {
  hashedKey: string;
  revision: number;
  envelope: number;
  kdfParams: number;
  blob: Uint8Array;
  updatedAt: number;
}

export interface WriteRow {
  revision: number;
  updatedAt: number;
}

function asRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Unexpected D1 row');
  return value;
}

function integerField(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Unexpected D1 column ${name}`);
  return value;
}

function nullableBlobField(row: Record<string, unknown>, name: string): Uint8Array | null {
  const value = row[name];
  return value === null ? null : toBytes(value);
}

const hexField = (row: Record<string, unknown>, name: string): string => bytesToHex(toBytes(row[name]));

/** Return one result of a batch. Refuse a missing one. */
export function resultAt(results: readonly D1Result<unknown>[], index: number): D1Result<unknown> {
  const result = results[index];
  if (!result) throw new Error(`Missing D1 batch result ${index}`);
  return result;
}

export function parseSaltRow(value: unknown): SaltRow {
  return { salt: nullableBlobField(asRow(value), 'salt') };
}

export function parseProfileStateRow(value: unknown): ProfileStateRow {
  const row = asRow(value);
  return { salt: nullableBlobField(row, 'salt'), generation: toBytes(row.generation) };
}

export function parseProfileRow(value: unknown): ProfileRow {
  const row = asRow(value);
  return { syncPublicKey: toBytes(row.sync_public_key), ...parseProfileStateRow(row) };
}

export function parseMetadataRow(value: unknown): MetadataRow {
  const row = asRow(value);
  return { hashedKey: hexField(row, 'hashed_key'), revision: integerField(row, 'revision') };
}

/** Return null for a row of a feature outside the allowlist. */
export function parseProfileMetadataRow(value: unknown): ProfileMetadataRow | null {
  const row = asRow(value);
  const { feature } = row;
  if (typeof feature !== 'string' || !isFeature(feature)) return null;
  return { feature, ...parseMetadataRow(row) };
}

export function parseEntryRow(value: unknown): EntryRow {
  const row = asRow(value);
  return {
    hashedKey: hexField(row, 'hashed_key'),
    revision: integerField(row, 'revision'),
    envelope: integerField(row, 'envelope'),
    kdfParams: integerField(row, 'kdf_params'),
    blob: toBytes(row.blob),
    updatedAt: integerField(row, 'updated_at')
  };
}

export function parseWriteRow(value: unknown): WriteRow {
  const row = asRow(value);
  return { revision: integerField(row, 'revision'), updatedAt: integerField(row, 'updated_at') };
}
