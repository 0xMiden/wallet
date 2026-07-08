import { useSyncExternalStore } from 'react';

import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, CardColor, DEFAULT_CARD_COLOR } from './constants';

/**
 * Balance-card color preference, persisted as plain text under
 * `balance_card_color`. Components read it via `useCardColor()`, which
 * re-renders subscribers when `setCardColor` runs (e.g. from the
 * AccountsDrawer picker).
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function getCardColor(): CardColor {
  try {
    const stored = localStorage.getItem(CARD_COLOR_STORAGE_KEY);
    const match = CARD_COLORS.find(color => color === stored);
    if (match) return match;
  } catch {}
  return DEFAULT_CARD_COLOR;
}

/** Persist a card color and notify subscribers. */
export function setCardColor(color: CardColor) {
  try {
    localStorage.setItem(CARD_COLOR_STORAGE_KEY, color);
  } catch {}
  listeners.forEach(listener => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive card color — re-renders when the picker changes it. */
export function useCardColor(): CardColor {
  return useSyncExternalStore(subscribe, getCardColor);
}
