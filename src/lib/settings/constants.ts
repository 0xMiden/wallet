export const DELEGATE_PROOF_STORAGE_KEY = 'delegate_proof_setting_key';
export const DEFAULT_DELEGATE_PROOF = true;

export const AUTO_CLOSE_STORAGE_KEY = 'auto_close_setting';
export const DEFAULT_AUTO_CLOSE = true;

export const AUTO_CONSUME_STORAGE_KEY = 'auto_consume_setting';
export const DEFAULT_AUTO_CONSUME = true;

// Marker written once `mirrorBackgroundSettings` has copied the user's real settings
// into the SW-readable KV store. The extension service worker gates its background
// native-note auto-consume on this so that, before the popup has run the migration, it
// does NOT act on read-miss defaults (which would auto-consume / remote-prove against a
// user who had opted out). Absent = not yet mirrored.
export const BG_SETTINGS_MIRRORED_KEY = 'bg_settings_mirrored';

export const HAPTIC_FEEDBACK_STORAGE_KEY = 'haptic_feedback_setting';
export const DEFAULT_HAPTIC_FEEDBACK = true;

export const CARD_COLOR_STORAGE_KEY = 'balance_card_color';
export type CardColor = 'slate' | 'orange' | 'blue' | 'green' | 'purple';
export const CARD_COLORS: CardColor[] = ['slate', 'orange', 'blue', 'green', 'purple'];
export const DEFAULT_CARD_COLOR: CardColor = 'slate';

export const THEME_STORAGE_KEY = 'theme_setting';
export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const DEFAULT_THEME: ThemeSetting = 'system';

export const GUARDIAN_URL_STORAGE_KEY = 'guardian_url_setting';
