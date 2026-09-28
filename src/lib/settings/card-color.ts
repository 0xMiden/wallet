import { CARD_COLOR_STORAGE_KEY, CARD_COLORS, CardColor, DEFAULT_CARD_COLOR } from './constants';
import { createPersistedSetting } from './persisted-setting';

/**
 * Balance-card color preference, persisted as plain text under
 * `balance_card_color`. Components read it via `useCardColor()`, which
 * re-renders subscribers when `setCardColor` runs (e.g. from the
 * AccountsDrawer picker).
 */
const cardColor = createPersistedSetting<CardColor>(CARD_COLOR_STORAGE_KEY, CARD_COLORS, DEFAULT_CARD_COLOR);

export const getCardColor = cardColor.get;

/** Persist a card color and notify subscribers. */
export const setCardColor = cardColor.set;

/** Reactive card color — re-renders when the picker changes it. */
export const useCardColor = cardColor.useValue;
