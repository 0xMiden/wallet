import { DEFAULT_NOMINAL_UNQUOTED_PRICE, NOMINAL_UNQUOTED_PRICE_STORAGE_KEY } from './constants';
import { createPersistedSetting } from './persisted-setting';

const NOMINAL_UNQUOTED_PRICE_VALUES = ['on', 'off'] as const;
type NominalUnquotedPriceValue = (typeof NOMINAL_UNQUOTED_PRICE_VALUES)[number];

/**
 * The "value unquoted tokens at $1" switch on Settings > Developer > Advanced Settings, persisted
 * as plain text under `nominal_unquoted_price_setting`. Off by default, so a token the feed does
 * not list shows no figure (the dash) until a developer turns it on. A per-device display
 * preference, like the balance card's colour: it applies at once, with no save. It only has an
 * effect off mainnet (`lib/prices/unquoted-default`).
 */
const nominalUnquotedPrice = createPersistedSetting<NominalUnquotedPriceValue>(
  NOMINAL_UNQUOTED_PRICE_STORAGE_KEY,
  NOMINAL_UNQUOTED_PRICE_VALUES,
  DEFAULT_NOMINAL_UNQUOTED_PRICE
);

export const isNominalUnquotedPriceEnabled = (): boolean => nominalUnquotedPrice.get() === 'on';

/** Persist the switch and notify subscribers. */
export const setNominalUnquotedPriceSetting = (enabled: boolean): void =>
  nominalUnquotedPrice.set(enabled ? 'on' : 'off');

/** Called on every change of the switch, in this window or another, for readers outside React. */
export const subscribeNominalUnquotedPrice = nominalUnquotedPrice.subscribe;

/** Reactive switch state, so the Developer Settings row re-renders when it is tapped. */
export const useNominalUnquotedPrice = (): boolean => nominalUnquotedPrice.useValue() === 'on';
