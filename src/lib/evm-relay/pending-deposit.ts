/**
 * A deposit to the relay address that the user reviewed and did not fund yet. It is a small storage record, not a
 * transaction row: the bridge flow creates its row only when the bridge starts. The record lets the wallet show the
 * deposit again (a Home row, the address screen) after the user leaves it.
 *
 * Storage: one key for each account, `relay_pending_deposits_v1:<accountPublicKey>`, written only through
 * `putToStorage` and read through the storage hook, so the hooks' cache stays current on every platform. Every wallet
 * wipe removes the key (it is not in `PRESERVED_STORAGE_KEYS`) and re-reads the hooks' cache.
 */
import { useMemo } from 'react';

import type { Address } from 'viem';

import { fetchFromStorage, inStorageTurn, putToStorage, useStorage } from 'lib/miden/front/storage';
import { isRecord } from 'lib/update/guards';

import { lowerAddress } from './parse';

export interface PendingRelayDeposit {
  /** A random id (`createPendingRelayDepositId`). */
  id: string;
  accountPublicKey: string;
  /** The relay address, in lower case. */
  address: Address;
  chainId: number;
  route: 'agglayer' | 'epoch';
  /** The token to deposit. The zero address is the native coin. The address is in lower case. */
  token: { address: Address; symbol: string; decimals: number };
  /** The reviewed amount, decimal text as typed. */
  amount: string;
  /** The same amount in base units, decimal text. More than zero. */
  amountBaseUnits: string;
  outputAmount?: string;
  outputSymbol?: string;
  /** Unix milliseconds. */
  createdAt: number;
  /** Opaque form state the deposit screen needs to open again on this deposit. A JSON object of strings. */
  form?: Record<string, string>;
}

/** The most pending deposits kept for one account. */
export const MAX_PENDING_RELAY_DEPOSITS = 5;

const KEY_PREFIX = 'relay_pending_deposits_v1:';
const MAX_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 32;
const MAX_FORM_ENTRIES = 32;
const MAX_FORM_KEY_LENGTH = 64;
const MAX_FORM_VALUE_LENGTH = 2048;
const MAX_DECIMALS = 36;
const DECIMAL_TEXT = /^[0-9]{1,78}(\.[0-9]{1,78})?$/;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;

/** The storage key of the pending deposits of an account. */
export const pendingRelayDepositsKey = (accountPublicKey: string): string => `${KEY_PREFIX}${accountPublicKey}`;

/** A new random id for a pending deposit. */
export function createPendingRelayDepositId(): string {
  return crypto.randomUUID();
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function decimalText(value: unknown): string | null {
  return typeof value === 'string' && DECIMAL_TEXT.test(value) ? value : null;
}

function parseToken(value: unknown): PendingRelayDeposit['token'] | null {
  if (!isRecord(value)) return null;
  const address = lowerAddress(value.address);
  const symbol = text(value.symbol, MAX_TEXT_LENGTH);
  const { decimals } = value;
  if (address === null || symbol === null) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    return null;
  }
  return { address, symbol, decimals };
}

function parseForm(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FORM_ENTRIES) return null;
  const form: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_FORM_KEY_LENGTH) return null;
    if (typeof entry !== 'string' || entry.length > MAX_FORM_VALUE_LENGTH) return null;
    form[key] = entry;
  }
  return form;
}

function parseRoute(value: unknown): PendingRelayDeposit['route'] | null {
  switch (value) {
    case 'agglayer':
    case 'epoch':
      return value;
    default:
      return null;
  }
}

/**
 * One pending deposit of `accountPublicKey`, or null when `value` does not match the record exactly (the account
 * included). Unknown fields are dropped.
 */
export function parsePendingRelayDeposit(value: unknown, accountPublicKey: string): PendingRelayDeposit | null {
  if (!isRecord(value) || value.accountPublicKey !== accountPublicKey) return null;
  const id = text(value.id, MAX_ID_LENGTH);
  const address = lowerAddress(value.address);
  const route = parseRoute(value.route);
  const token = parseToken(value.token);
  const amount = decimalText(value.amount);
  const { chainId, createdAt, amountBaseUnits } = value;
  if (id === null || address === null || route === null || token === null || amount === null) return null;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  if (typeof amountBaseUnits !== 'string' || !BASE_UNITS.test(amountBaseUnits)) return null;
  const deposit: PendingRelayDeposit = {
    id,
    accountPublicKey,
    address,
    chainId,
    route,
    token,
    amount,
    amountBaseUnits,
    createdAt
  };
  if (value.outputAmount !== undefined) {
    const outputAmount = decimalText(value.outputAmount);
    if (outputAmount === null) return null;
    deposit.outputAmount = outputAmount;
  }
  if (value.outputSymbol !== undefined) {
    const outputSymbol = text(value.outputSymbol, MAX_TEXT_LENGTH);
    if (outputSymbol === null) return null;
    deposit.outputSymbol = outputSymbol;
  }
  if (value.form !== undefined) {
    const form = parseForm(value.form);
    if (form === null) return null;
    deposit.form = form;
  }
  return deposit;
}

/** Newest first, at most `MAX_PENDING_RELAY_DEPOSITS`, one entry for each id (the first one wins). */
function newestFirst(deposits: PendingRelayDeposit[]): PendingRelayDeposit[] {
  const seen = new Set<string>();
  const unique = deposits.filter(deposit => {
    if (seen.has(deposit.id)) return false;
    seen.add(deposit.id);
    return true;
  });
  return unique.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PENDING_RELAY_DEPOSITS);
}

/** The pending deposits of `accountPublicKey` in a stored value. An entry that does not parse is dropped. */
export function parsePendingRelayDeposits(value: unknown, accountPublicKey: string): PendingRelayDeposit[] {
  if (!Array.isArray(value)) return [];
  return newestFirst(value.flatMap(entry => parsePendingRelayDeposit(entry, accountPublicKey) ?? []));
}

/** The stored pending deposits of an account, newest first. */
export async function readPendingRelayDeposits(accountPublicKey: string): Promise<PendingRelayDeposit[]> {
  return parsePendingRelayDeposits(await fetchFromStorage(pendingRelayDepositsKey(accountPublicKey)), accountPublicKey);
}

/** Reads, changes and writes the list of one account in one storage turn, so two writers do not lose an entry. */
async function updatePendingRelayDeposits(
  accountPublicKey: string,
  change: (deposits: PendingRelayDeposit[]) => PendingRelayDeposit[]
): Promise<void> {
  const key = pendingRelayDepositsKey(accountPublicKey);
  await inStorageTurn(key, async () => {
    const current = parsePendingRelayDeposits(await fetchFromStorage(key), accountPublicKey);
    await putToStorage(key, newestFirst(change(current)));
  });
}

/**
 * Stores `deposit` for its account, in the place of an entry with the same id. The list keeps the newest
 * `MAX_PENDING_RELAY_DEPOSITS`. Throws a `TypeError` for a deposit that does not parse, before any write.
 */
export async function savePendingRelayDeposit(deposit: PendingRelayDeposit): Promise<void> {
  const parsed = parsePendingRelayDeposit(deposit, deposit.accountPublicKey);
  if (parsed === null) throw new TypeError('relay: the pending deposit is not valid');
  await updatePendingRelayDeposits(parsed.accountPublicKey, deposits => [
    parsed,
    ...deposits.filter(entry => entry.id !== parsed.id)
  ]);
}

/** Removes the pending deposit `id` of an account. Nothing happens when it is not there. */
export async function removePendingRelayDeposit(accountPublicKey: string, id: string): Promise<void> {
  await updatePendingRelayDeposits(accountPublicKey, deposits => deposits.filter(entry => entry.id !== id));
}

/**
 * The pending deposits of an account, newest first, through the storage hook (it suspends on its first read, as every
 * `useStorage` reader does). Empty while `accountPublicKey` is undefined.
 */
export function usePendingRelayDeposits(accountPublicKey: string | undefined): PendingRelayDeposit[] {
  // A hook runs on every render, so an undefined account reads the empty-account key, which nothing writes.
  const [stored] = useStorage<unknown>(pendingRelayDepositsKey(accountPublicKey ?? ''), null);
  return useMemo(
    () => (accountPublicKey === undefined ? [] : parsePendingRelayDeposits(stored, accountPublicKey)),
    [stored, accountPublicKey]
  );
}
