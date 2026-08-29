import { useSyncExternalStore } from 'react';

import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, CardColor, DEFAULT_CARD_COLOR } from './constants';

/**
 * Balance-card color preferences, persisted as plain text per Miden account.
 * The former wallet-wide `balance_card_color` value remains the fallback so
 * existing users keep their chosen color until they customize an account.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

function accountCardColorStorageKey(accountId: string) {
  return `${CARD_COLOR_STORAGE_KEY}:${accountId}`;
}

function findCardColor(stored: string | null): CardColor | undefined {
  return CARD_COLORS.find(color => color === stored);
}

export function getCardColor(accountId?: string): CardColor {
  try {
    if (accountId) {
      const accountColor = findCardColor(localStorage.getItem(accountCardColorStorageKey(accountId)));
      if (accountColor) return accountColor;
    }
    const legacyColor = findCardColor(localStorage.getItem(CARD_COLOR_STORAGE_KEY));
    if (legacyColor) return legacyColor;
  } catch {}
  return DEFAULT_CARD_COLOR;
}

/** Persist a card color and notify subscribers. */
export function setCardColor(accountId: string, color: CardColor) {
  try {
    localStorage.setItem(accountCardColorStorageKey(accountId), color);
  } catch {}
  listeners.forEach(listener => listener());
}

/**
 * Give newly observed accounts a stable initial color. Account 1 keeps the
 * legacy/default preference; every later account advances one palette slot
 * from its predecessor, so palette wraparound never makes adjacent accounts
 * look the same. Explicit user choices are never overwritten.
 */
export function initializeAccountCardColors(accountIds: string[]) {
  let changed = false;
  try {
    for (let index = 1; index < accountIds.length; index += 1) {
      const accountId = accountIds[index];
      const previousAccountId = accountIds[index - 1];
      if (!accountId || !previousAccountId) continue;

      const storedColor = findCardColor(localStorage.getItem(accountCardColorStorageKey(accountId)));
      if (storedColor) continue;

      const previousColor = getCardColor(previousAccountId);
      const previousColorIndex = CARD_COLORS.findIndex(color => color === previousColor);
      const nextColor = CARD_COLORS[(previousColorIndex + 1) % CARD_COLORS.length] ?? DEFAULT_CARD_COLOR;
      localStorage.setItem(accountCardColorStorageKey(accountId), nextColor);
      changed = true;
    }
  } catch {}
  if (changed) listeners.forEach(listener => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive card color — re-renders when the picker changes it. */
export function useCardColor(accountId?: string): CardColor {
  return useSyncExternalStore(subscribe, () => getCardColor(accountId));
}
