import { v4 as uuid } from 'uuid';

/**
 * The active buy session's `externalTransactionId`, pinned in localStorage.
 * Every /buy mount ROTATES the slot (fresh uuid), the widget URL carries it,
 * MoonPay echoes it on the transaction it creates, and the app-root watcher
 * (`BuyBridgeManager` — it outlives the /buy screen) polls whatever the slot
 * holds. Discarding a session = clearing the slot: the watcher clears it once
 * the bridge is initiated. The tracked purchase itself is a `buy` activity row
 * in Dexie (`BuyTransaction`), not localStorage.
 */
const BUY_EXTERNAL_ID_KEY = 'moonpay-buy-external-id';

/** The active session uuid, or null when no buy session exists. */
export function peekBuyExternalId(): string | null {
  return localStorage.getItem(BUY_EXTERNAL_ID_KEY);
}

/** Called on /buy mount: mint a fresh session uuid, replacing any previous one. */
export function startBuySession(): string {
  const fresh = uuid();
  localStorage.setItem(BUY_EXTERNAL_ID_KEY, fresh);
  return fresh;
}

export function clearBuySession(): void {
  localStorage.removeItem(BUY_EXTERNAL_ID_KEY);
}
