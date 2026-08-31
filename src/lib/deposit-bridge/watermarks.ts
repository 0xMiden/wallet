import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { isDepositTokenId, type DepositTokenId } from './tokens';

/**
 * Per-address, per-token arrival watermarks.
 *
 * Amounts are DECIMAL STRINGS, not bigints — this record round-trips through
 * JSON platform storage, which cannot carry bigint. Two independent marks:
 *
 *  - `acknowledged`: the balance the user has already acted on (bridged). A
 *    balance above it is an arrival.
 *  - `drawerShown`: the balance the arrival drawer was last opened for, so the
 *    same deposit never re-opens it while a LARGER later deposit still does.
 */

const STORAGE_KEY = 'deposit_address_watermarks_v1';

export interface DepositWatermark {
  acknowledged: string;
  drawerShown: string;
  updatedAt: number;
}

/** Keyed `${lowercasedAddress}:${token}`. */
export type DepositWatermarkStore = Record<string, DepositWatermark>;

export function watermarkKey(address: string, token: DepositTokenId): string {
  return `${address.trim().toLowerCase()}:${token}`;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

/** Coerce one untyped stored entry, dropping anything that isn't a usable record. */
function normalizeEntry(key: string, value: unknown): DepositWatermark | undefined {
  const [address, token] = key.split(':');
  if (!address || !isDepositTokenId(token)) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const acknowledged: unknown = Reflect.get(value, 'acknowledged');
  const drawerShown: unknown = Reflect.get(value, 'drawerShown');
  const updatedAt: unknown = Reflect.get(value, 'updatedAt');
  if (!isDecimalString(acknowledged)) return undefined;
  return {
    acknowledged,
    drawerShown: isDecimalString(drawerShown) ? drawerShown : acknowledged,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0
  };
}

/**
 * Read the whole store, discarding garbage. Storage is user-writable state that
 * survives upgrades, so an unreadable entry must degrade to "no record" (which
 * re-seeds at the current balance) rather than throwing on the poll path.
 */
export async function readWatermarks(): Promise<DepositWatermarkStore> {
  const stored = await fetchFromStorage<unknown>(STORAGE_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const out: DepositWatermarkStore = {};
  for (const key of Object.keys(stored)) {
    const entry = normalizeEntry(key, Reflect.get(stored, key));
    if (entry) out[key] = entry;
  }
  return out;
}

export async function readWatermark(address: string, token: DepositTokenId): Promise<DepositWatermark | undefined> {
  const store = await readWatermarks();
  return store[watermarkKey(address, token)];
}

export interface DepositWatermarkPatch {
  acknowledged?: bigint;
  drawerShown?: bigint;
}

/**
 * Patch one address+token record. The store is RE-READ inside the patch so a
 * concurrent write to another key is never clobbered (last-writer-wins applies
 * per key, not per store). Returns the written store.
 */
export async function patchWatermark(
  address: string,
  token: DepositTokenId,
  patch: DepositWatermarkPatch
): Promise<DepositWatermarkStore> {
  const store = await readWatermarks();
  const key = watermarkKey(address, token);
  const current = store[key];
  const acknowledged = patch.acknowledged !== undefined ? patch.acknowledged.toString() : (current?.acknowledged ?? '0');
  const drawerShown =
    patch.drawerShown !== undefined ? patch.drawerShown.toString() : (current?.drawerShown ?? acknowledged);
  const next: DepositWatermarkStore = {
    ...store,
    [key]: { acknowledged, drawerShown, updatedAt: Date.now() }
  };
  await putToStorage(STORAGE_KEY, next);
  return next;
}
