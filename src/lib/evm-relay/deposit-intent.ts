/**
 * What the user chose when they opened the deposit address. The deposit address is the same for every route, so the
 * wallet keeps the chosen route per account. `useRelayDeposit` reads the key through a storage hook, so every write
 * goes through `putToStorage`. A wallet reset removes the key and re-reads the hooks' cache (`lib/miden/reset.ts`).
 */
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import type { RelayDepositTarget } from './deposit';

export function relayDepositIntentKey(accountPublicKey: string): string {
  return `relay_deposit_intent_v1:${accountPublicKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored value as an intent, the token in lower case, or null when it is not one. */
export function readRelayDepositIntent(value: unknown): RelayDepositTarget | null {
  if (!isRecord(value) || value.provider !== 'agglayer') return null;
  const { chainId, token } = value;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (typeof token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  return { provider: 'agglayer', chainId, token: token.toLowerCase() };
}

/** The account's intent, read outside React. */
export async function fetchRelayDepositIntent(accountPublicKey: string): Promise<RelayDepositTarget | null> {
  return readRelayDepositIntent(await fetchFromStorage(relayDepositIntentKey(accountPublicKey)));
}

/** Stores the account's intent; null clears it. Throws when the intent is not valid. */
export async function saveRelayDepositIntent(
  accountPublicKey: string,
  intent: RelayDepositTarget | null
): Promise<void> {
  const value = intent === null ? null : readRelayDepositIntent(intent);
  if (intent !== null && value === null) throw new TypeError('relay: the deposit intent is not valid');
  await putToStorage(relayDepositIntentKey(accountPublicKey), value);
}
