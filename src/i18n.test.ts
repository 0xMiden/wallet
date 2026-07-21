/**
 * `i18n.ts` performs all of its work at module scope: it reads the saved locale
 * from `localStorage` (normalizing `en_GB` -> `en-GB` for i18next) and then
 * initializes an i18next singleton with the bundled `_locales/*` resources.
 *
 * To cover both `localStorage` branches (a saved locale present vs. absent) we
 * clear the module registry and re-`require('./i18n')` with different storage
 * state — the same `jest.resetModules()` + `require()` pattern used elsewhere in
 * this repo (e.g. `lib/browser-info.test.ts`). The real i18next / react-i18next /
 * LanguageDetector packages are used directly since they run cleanly under jsdom
 * and only `src/i18n.ts` is under coverage here.
 */

type I18nInstance = typeof import('i18next').default;

/**
 * Reset modules, seed `localStorage`, then import the module fresh so its
 * top-level `i18n.init(...)` re-runs against the seeded storage. Returns the
 * configured (default-exported) i18next singleton.
 */
const loadI18n = (locale?: string): I18nInstance => {
  jest.resetModules();
  // Wipe any 'i18nextLng' the LanguageDetector may have cached on a prior load.
  localStorage.clear();
  if (locale !== undefined) {
    localStorage.setItem('locale', locale);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./i18n') as { default: I18nInstance }).default;
};

// Every locale bundle wired into the `resources` map in i18n.ts.
const EXPECTED_LANGUAGES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh-CN', 'zh-TW'];

describe('i18n', () => {
  afterEach(() => {
    localStorage.clear();
  });

  describe('module initialization', () => {
    it('initializes the i18next singleton synchronously', () => {
      const i18n = loadI18n();
      expect(i18n.isInitialized).toBe(true);
    });

    it('default-exports the configured i18next singleton', () => {
      const i18n = loadI18n();
      // Within a single load the module registry is shared, so the instance the
      // module wires up is the same singleton `i18next` resolves to. i18next's
      // CJS build exposes the instance as the module export itself (no `.default`
      // interop wrapper), so accept either shape.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const i18next = require('i18next') as { default?: I18nInstance };
      expect(i18n).toBe(i18next.default ?? i18next);
    });
  });

  describe('interpolation + fallback configuration', () => {
    it('uses $-delimited interpolation with HTML escaping disabled', () => {
      const i18n = loadI18n();
      expect(i18n.options.interpolation).toMatchObject({
        prefix: '$',
        suffix: '$',
        escapeValue: false
      });
    });

    it('falls back to English', () => {
      const i18n = loadI18n();
      // i18next may normalize `fallbackLng: 'en'` to `['en']`; accept either.
      expect([].concat(i18n.options.fallbackLng as never)).toContain('en');
    });

    it('allows non-explicit supported languages and runs with debug off', () => {
      const i18n = loadI18n();
      expect(i18n.options.nonExplicitSupportedLngs).toBe(true);
      expect(i18n.options.debug).toBe(false);
    });

    it('registers every bundled locale resource under `translation`', () => {
      const i18n = loadI18n();
      const resources = i18n.options.resources ?? {};
      expect(Object.keys(resources).sort()).toEqual([...EXPECTED_LANGUAGES].sort());
      // Each entry namespaces its strings under the `translation` key.
      for (const lng of EXPECTED_LANGUAGES) {
        expect(resources[lng]).toHaveProperty('translation');
      }
    });

    it('actually translates a known key against the bundled English resource', () => {
      const i18n = loadI18n();
      // The English bundle is the fallback; pick any real key and confirm it
      // resolves to a non-key string (proves the resources were loaded).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const en = require('../public/_locales/en/en.json') as Record<string, unknown>;
      const [firstKey] = Object.keys(en);
      expect(typeof firstKey).toBe('string');
      expect(i18n.getResource('en', 'translation', firstKey!)).toBeDefined();
    });
  });

  describe('saved-locale branch (localStorage present)', () => {
    it('uses the saved locale, normalizing an underscore region to a hyphen', () => {
      const i18n = loadI18n('en_GB');
      expect(i18n.options.lng).toBe('en-GB');
      expect(i18n.language).toBe('en-GB');
    });

    it('normalizes any underscore region code (de_AT -> de-AT)', () => {
      const i18n = loadI18n('de_AT');
      expect(i18n.language).toBe('de-AT');
    });

    it('passes a locale without an underscore through unchanged', () => {
      const i18n = loadI18n('fr');
      expect(i18n.options.lng).toBe('fr');
      expect(i18n.language).toBe('fr');
    });
  });

  describe('no-saved-locale branch (localStorage empty)', () => {
    it('leaves `lng` undefined so LanguageDetector / fallback decides', () => {
      const i18n = loadI18n(); // no 'locale' key set
      expect(i18n.options.lng).toBeUndefined();
      // The detector (or the `en` fallback) still resolves to a real language.
      expect(typeof i18n.language).toBe('string');
      expect(i18n.language.length).toBeGreaterThan(0);
    });
  });
});
