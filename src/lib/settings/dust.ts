import { DEFAULT_HIDE_DUST_TOKENS, HIDE_DUST_TOKENS_STORAGE_KEY } from './constants';
import { createPersistedSetting } from './persisted-setting';

const HIDE_DUST_TOKENS_VALUES = ['on', 'off'] as const;
type HideDustTokensValue = (typeof HIDE_DUST_TOKENS_VALUES)[number];

/**
 * The "Hide dust tokens" switch on Settings > General, kept as plain text under
 * `hide_dust_tokens_setting`. On by default. It is a display preference for this device: it
 * applies immediately, with no save. `lib/miden/front/dust` defines which token is dust.
 */
const hideDustTokens = createPersistedSetting<HideDustTokensValue>(
  HIDE_DUST_TOKENS_STORAGE_KEY,
  HIDE_DUST_TOKENS_VALUES,
  DEFAULT_HIDE_DUST_TOKENS
);

/** Save the switch and notify subscribers. */
export const setHideDustTokensSetting = (enabled: boolean): void => hideDustTokens.set(enabled ? 'on' : 'off');

/** Reactive switch state: Home and the settings row render again when the switch changes. */
export const useHideDustTokens = (): boolean => hideDustTokens.useValue() === 'on';
