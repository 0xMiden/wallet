export const DELEGATE_PROOF_STORAGE_KEY = 'delegate_proof_setting_key';
export const DEFAULT_DELEGATE_PROOF = true;

export const AUTO_CONSUME_STORAGE_KEY = 'auto_consume_setting';
export const DEFAULT_AUTO_CONSUME = true;

export const TELEMETRY_STORAGE_KEY = 'telemetry_consent_setting';
/**
 * Off until the user turns it on. Also the read-miss default for the
 * background mirror, so a mirror failure fails closed rather than sending.
 */
export const DEFAULT_TELEMETRY = false;

// Marker written once `mirrorBackgroundSettings` has copied the user's real settings
// into the SW-readable KV store. The extension service worker gates its background
// native-note auto-consume on this so that, before the popup has run the migration, it
// does NOT act on read-miss defaults (which would auto-consume / remote-prove against a
// user who had opted out). Absent = not yet mirrored.
export const BG_SETTINGS_MIRRORED_KEY = 'bg_settings_mirrored';

export const HAPTIC_FEEDBACK_STORAGE_KEY = 'haptic_feedback_setting';
export const DEFAULT_HAPTIC_FEEDBACK = true;

/**
 * Advanced Settings' "value unquoted tokens at $1" switch (`lib/settings/nominal-price`). Off
 * by default: a token the price feed does not list shows the dash until a developer turns it on.
 */
export const NOMINAL_UNQUOTED_PRICE_STORAGE_KEY = 'nominal_unquoted_price_setting';
export const DEFAULT_NOMINAL_UNQUOTED_PRICE = 'off';

export const CARD_COLOR_STORAGE_KEY = 'balance_card_color';
export type CardColor = 'slate' | 'orange' | 'blue' | 'green' | 'purple';
export const CARD_COLORS: CardColor[] = ['slate', 'orange', 'blue', 'green', 'purple'];
export const DEFAULT_CARD_COLOR: CardColor = 'slate';

/**
 * Which view the Activity tab opens in: the flat, date-grouped feed, or one row per counterparty
 * or category. A per-device display preference, like the theme and the balance card's colour, so
 * it lives here rather than in the vault-backed `WalletSettings`.
 */
export const ACTIVITY_VIEW_STORAGE_KEY = 'activity_view_setting';
export type ActivityView = 'list' | 'groups';
export const ACTIVITY_VIEWS: ActivityView[] = ['list', 'groups'];
export const DEFAULT_ACTIVITY_VIEW: ActivityView = 'list';

/**
 * Which activity rows the user has already looked at. A per-device display preference, like the
 * Activity view above — an unread mark is about this installation's reading, not about the
 * account, so it never goes near the vault-backed `WalletSettings`.
 */
export const ACTIVITY_READ_STORAGE_KEY = 'activity_read_setting';
/**
 * How many individually-read ids are kept before the high-water mark is advanced to absorb the
 * oldest of them. See `activity-read.ts` for what advancing means; the number only has to be
 * larger than a session's worth of taps.
 */
export const ACTIVITY_READ_MAX_IDS = 100;

export const THEME_STORAGE_KEY = 'theme_setting';
export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const DEFAULT_THEME: ThemeSetting = 'system';
