export const POPUP_MODE_STORAGE_KEY = 'popup_mode';
export const DEFAULT_POPUP_MODE = true;

export function setPopupMode(enabled: boolean) {
  try {
    localStorage.setItem(POPUP_MODE_STORAGE_KEY, JSON.stringify(enabled));
  } catch {}
}

export function isPopupModeEnabled() {
  const stored = localStorage.getItem(POPUP_MODE_STORAGE_KEY);
  if (!stored) {
    return DEFAULT_POPUP_MODE;
  }
  
  try {
    return JSON.parse(stored) as boolean;
  } catch {
    // Gracefully handle corrupted localStorage data
    // instead of crashing the entire extension
    return DEFAULT_POPUP_MODE;
  }
}
