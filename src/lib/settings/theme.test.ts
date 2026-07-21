import { THEME_STORAGE_KEY } from './constants';

const APP_BG = 'var(--color-app-bg)';

// theme.ts keeps module-level state (`mediaListenerAttached`) that must not
// leak between the listener tests. `loadTheme()` re-requires the module inside
// a fresh module registry so every caller gets a pristine copy where the
// media-query listener has NOT yet been attached.
function loadTheme(): typeof import('./theme') {
  let mod!: typeof import('./theme');
  jest.isolateModules(() => {
    mod = require('./theme');
  });
  return mod;
}

interface FakeMql {
  matches: boolean;
  media: string;
  addEventListener?: jest.Mock;
  removeEventListener?: jest.Mock;
  addListener?: jest.Mock;
  removeListener?: jest.Mock;
  _trigger: () => void;
}

// Install a controllable `window.matchMedia` stub. jsdom ships none, so tests
// that exercise the 'system' path have to provide one. `modern`/`legacy`
// decide which subscription API the returned MediaQueryList exposes.
function installMatchMedia({
  matches = false,
  modern = true,
  legacy = false
}: { matches?: boolean; modern?: boolean; legacy?: boolean } = {}): {
  matchMedia: jest.Mock;
  mql: FakeMql;
} {
  const listeners: Array<() => void> = [];
  const mql: FakeMql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    _trigger: () => listeners.slice().forEach(cb => cb())
  };
  if (modern) {
    mql.addEventListener = jest.fn((_event: string, cb: () => void) => {
      listeners.push(cb);
    });
    mql.removeEventListener = jest.fn();
  }
  if (legacy) {
    mql.addListener = jest.fn((cb: () => void) => {
      listeners.push(cb);
    });
    mql.removeListener = jest.fn();
  }
  const matchMedia = jest.fn(() => mql);
  (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  return { matchMedia, mql };
}

function hasDarkClass(): boolean {
  return document.documentElement.classList.contains('dark');
}

describe('lib/settings/theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.backgroundColor = '';
    document.body.style.backgroundColor = '';
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    jest.clearAllMocks();
  });

  describe('resolveTheme', () => {
    it('returns the explicit setting unchanged for "light"', () => {
      const { resolveTheme } = loadTheme();
      expect(resolveTheme('light')).toBe('light');
    });

    it('returns the explicit setting unchanged for "dark"', () => {
      const { resolveTheme } = loadTheme();
      expect(resolveTheme('dark')).toBe('dark');
    });

    it('resolves "system" to "dark" when the OS prefers dark', () => {
      const { matchMedia } = installMatchMedia({ matches: true });
      const { resolveTheme } = loadTheme();
      expect(resolveTheme('system')).toBe('dark');
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });

    it('resolves "system" to "light" when the OS prefers light', () => {
      installMatchMedia({ matches: false });
      const { resolveTheme } = loadTheme();
      expect(resolveTheme('system')).toBe('light');
    });

    it('resolves "system" to "light" when matchMedia is unavailable', () => {
      // No matchMedia installed -> the `typeof window.matchMedia === 'function'`
      // guard short-circuits and we fall back to light.
      const { resolveTheme } = loadTheme();
      expect(resolveTheme('system')).toBe('light');
    });
  });

  describe('applyTheme', () => {
    it('adds the "dark" class and paints both <html> and <body> for a dark theme', () => {
      const { applyTheme } = loadTheme();
      applyTheme('dark');
      expect(hasDarkClass()).toBe(true);
      expect(document.documentElement.style.backgroundColor).toBe(APP_BG);
      expect(document.body.style.backgroundColor).toBe(APP_BG);
    });

    it('removes the "dark" class for a light theme', () => {
      const { applyTheme } = loadTheme();
      document.documentElement.classList.add('dark');
      applyTheme('light');
      expect(hasDarkClass()).toBe(false);
      expect(document.documentElement.style.backgroundColor).toBe(APP_BG);
      expect(document.body.style.backgroundColor).toBe(APP_BG);
    });

    it('resolves a "system" setting through matchMedia before painting', () => {
      installMatchMedia({ matches: true });
      const { applyTheme } = loadTheme();
      applyTheme('system');
      expect(hasDarkClass()).toBe(true);
    });
  });

  describe('setTheme', () => {
    it('persists the setting and applies the dark theme', () => {
      const { setTheme } = loadTheme();
      setTheme('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      expect(hasDarkClass()).toBe(true);
    });

    it('persists the setting and applies the light theme', () => {
      const { setTheme } = loadTheme();
      document.documentElement.classList.add('dark');
      setTheme('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
      expect(hasDarkClass()).toBe(false);
    });
  });

  describe('toggleTheme', () => {
    it('flips an explicit dark setting to light and returns it', () => {
      const { setTheme, toggleTheme } = loadTheme();
      setTheme('dark');
      const next = toggleTheme();
      expect(next).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
      expect(hasDarkClass()).toBe(false);
    });

    it('flips an explicit light setting to dark and returns it', () => {
      const { setTheme, toggleTheme } = loadTheme();
      setTheme('light');
      const next = toggleTheme();
      expect(next).toBe('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      expect(hasDarkClass()).toBe(true);
    });

    it('resolves a "system" setting through matchMedia when deciding the flip', () => {
      // system currently resolves to dark -> toggle should land on light.
      installMatchMedia({ matches: true });
      const { setTheme, toggleTheme } = loadTheme();
      setTheme('system');
      const next = toggleTheme();
      expect(next).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    });
  });

  describe('initTheme / system listener', () => {
    it('applies the stored theme without throwing when matchMedia is unavailable', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      const { initTheme } = loadTheme();
      expect(() => initTheme()).not.toThrow();
      expect(hasDarkClass()).toBe(true);
    });

    it('subscribes via addEventListener when the modern API is available', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      const { mql } = installMatchMedia({ modern: true, legacy: false });
      const { initTheme } = loadTheme();
      initTheme();
      expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('falls back to addListener when only the legacy API is available', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      const { mql } = installMatchMedia({ modern: false, legacy: true });
      const { initTheme } = loadTheme();
      initTheme();
      expect(mql.addListener).toHaveBeenCalledWith(expect.any(Function));
    });

    it('does not throw when the MediaQueryList exposes neither subscription API', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      const { matchMedia } = installMatchMedia({ modern: false, legacy: false });
      const { initTheme } = loadTheme();
      expect(() => initTheme()).not.toThrow();
      // Proves we got past the early-return guard into the body.
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });

    it('attaches the listener only once across repeated initTheme calls', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      const { mql } = installMatchMedia({ modern: true });
      const { initTheme } = loadTheme();
      initTheme();
      initTheme();
      expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('re-applies the theme on an OS change while the setting is "system"', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'system');
      const { mql } = installMatchMedia({ matches: false, modern: true });
      const { initTheme } = loadTheme();
      initTheme();
      expect(hasDarkClass()).toBe(false); // starts light

      mql.matches = true; // OS switches to dark
      mql._trigger();
      expect(hasDarkClass()).toBe(true);
    });

    it('ignores OS changes when the setting is an explicit theme', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      const { mql } = installMatchMedia({ matches: false, modern: true });
      const { initTheme } = loadTheme();
      initTheme();
      expect(hasDarkClass()).toBe(false);

      mql.matches = true; // OS switches to dark, but setting is 'light'
      mql._trigger();
      expect(hasDarkClass()).toBe(false); // handler is a no-op
    });
  });
});
