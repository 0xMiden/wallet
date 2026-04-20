import { ResolvedTheme, ThemeSetting } from './constants';
import { getThemeSetting, setThemeSetting } from './helpers';

/**
 * Resolve a ThemeSetting to a concrete 'light' | 'dark' by consulting
 * prefers-color-scheme when the user picked 'system'.
 */
export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'system') {
    const prefersDark =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }
  return setting;
}

export function applyTheme(setting: ThemeSetting) {
  const resolved = resolveTheme(setting);
  const doc = document.documentElement;
  if (resolved === 'dark') {
    doc.classList.add('dark');
  } else {
    doc.classList.remove('dark');
  }
  // Paint BOTH <html> and <body>. The HTML shells (fullpage.html, mobile.html,
  // desktop.html, popup.html) hard-code a light inline `background-color` on
  // <html> for pre-React paint — without overriding it here, switching to dark
  // leaves the inline cream showing above the body and anywhere the body
  // doesn't stretch to fill (e.g. content shorter than viewport, or the 24px
  // margin-top fullpage.html sets on body).
  const bg = resolved === 'dark' ? '#191919' : '#F6F4F2';
  doc.style.backgroundColor = bg;
  document.body.style.backgroundColor = bg;
}

// Single listener for the OS-level light/dark toggle. When the user's setting
// is 'system' we re-apply on change; when it's an explicit 'light' / 'dark'
// the listener is a no-op (we still keep it attached to avoid subscription
// churn on every setTheme call).
let mediaListenerAttached = false;
function ensureSystemListener() {
  if (mediaListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getThemeSetting() === 'system') {
      applyTheme('system');
    }
  };
  // Safari <14 uses addListener; modern uses addEventListener. Prefer modern.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
  } else if (typeof (mql as any).addListener === 'function') {
    (mql as any).addListener(handler);
  }
  mediaListenerAttached = true;
}

export function initTheme() {
  applyTheme(getThemeSetting());
  ensureSystemListener();
}

/** Persist + apply a specific theme setting. */
export function setTheme(setting: ThemeSetting) {
  setThemeSetting(setting);
  applyTheme(setting);
}

/**
 * @deprecated Kept for callers that still expect the old boolean flip.
 * New code should use `setTheme(setting)` instead.
 */
export function toggleTheme(): ResolvedTheme {
  const current = resolveTheme(getThemeSetting());
  const next: ResolvedTheme = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
