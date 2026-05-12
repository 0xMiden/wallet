export const DELEGATE_PROOF_STORAGE_KEY = 'delegate_proof_setting_key';
// TEMPORARY (mobile-MT test): flipped to false so the iOS E2E send-receive
// run exercises the local-prove path. Restore to `true` before merging the
// mobile-MT PR; the production default stays "delegate to remote" so
// existing users see no behavior change. See plan: precious-twirling-parasol.md.
export const DEFAULT_DELEGATE_PROOF = false;

export const AUTO_CLOSE_STORAGE_KEY = 'auto_close_setting';
export const DEFAULT_AUTO_CLOSE = true;

export const AUTO_CONSUME_STORAGE_KEY = 'auto_consume_setting';
export const DEFAULT_AUTO_CONSUME = true;

export const HAPTIC_FEEDBACK_STORAGE_KEY = 'haptic_feedback_setting';
export const DEFAULT_HAPTIC_FEEDBACK = true;

export const THEME_STORAGE_KEY = 'theme_setting';
export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const DEFAULT_THEME: ThemeSetting = 'system';
