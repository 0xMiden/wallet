import browser from 'webextension-polyfill';

import {
  getMessage,
  getDateFnsLocale,
  getCldrLocale,
  getNumberSymbols,
  getCurrentLocale,
  getNativeLocale,
  getDefaultLocale,
  fetchLocaleMessages
} from './core';
import { getSavedLocale } from './saving';

// Mock dependencies
jest.mock('webextension-polyfill', () => ({
  i18n: {
    getMessage: jest.fn((key: string) => `native:${key}`),
    getUILanguage: jest.fn(() => 'en-US')
  },
  runtime: {
    getManifest: jest.fn(() => ({ default_locale: 'en' })),
    getURL: jest.fn((path: string) => `chrome-extension://test/${path}`)
  }
}));

jest.mock('./saving', () => ({
  getSavedLocale: jest.fn()
}));

// Mock fetch
global.fetch = jest.fn();

describe('i18n/core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSavedLocale as jest.Mock).mockReturnValue(null);
  });

  describe('getNativeLocale', () => {
    it('returns browser UI language', () => {
      (browser.i18n.getUILanguage as jest.Mock).mockReturnValue('fr-FR');

      expect(getNativeLocale()).toBe('fr-FR');
    });
  });

  describe('getDefaultLocale', () => {
    it('returns default locale from manifest', () => {
      (browser.runtime.getManifest as jest.Mock).mockReturnValue({ default_locale: 'de' });

      expect(getDefaultLocale()).toBe('de');
    });

    it('returns "en" when manifest has no default_locale', () => {
      (browser.runtime.getManifest as jest.Mock).mockReturnValue({});

      expect(getDefaultLocale()).toBe('en');
    });
  });

  describe('getCurrentLocale', () => {
    it('returns saved locale when available', () => {
      (getSavedLocale as jest.Mock).mockReturnValue('ja');

      expect(getCurrentLocale()).toBe('ja');
    });

    it('returns native locale when no saved locale', () => {
      (getSavedLocale as jest.Mock).mockReturnValue(null);
      (browser.i18n.getUILanguage as jest.Mock).mockReturnValue('ko');

      expect(getCurrentLocale()).toBe('ko');
    });
  });

  describe('getMessage', () => {
    it('falls back to browser.i18n.getMessage when no fetched messages', () => {
      const result = getMessage('testKey');

      expect(browser.i18n.getMessage).toHaveBeenCalledWith('testKey', undefined);
      expect(result).toBe('native:testKey');
    });

    it('passes substitutions to browser.i18n.getMessage', () => {
      getMessage('testKey', { first: 'arg1', second: 'arg2' });

      expect(browser.i18n.getMessage).toHaveBeenCalledWith('testKey', ['arg1', 'arg2']);
    });
  });

  describe('getDateFnsLocale', () => {
    it('returns a date-fns locale object', () => {
      (getSavedLocale as jest.Mock).mockReturnValue('en');

      const locale = getDateFnsLocale();

      expect(locale).toBeDefined();
      expect(locale.code).toBeDefined();
    });

    it('returns enUS as default for unknown locale', () => {
      (getSavedLocale as jest.Mock).mockReturnValue('unknown');

      const locale = getDateFnsLocale();

      expect(locale.code).toBe('en-US');
    });
  });

  describe('getCldrLocale', () => {
    it('returns CLDR locale data', () => {
      const cldr = getCldrLocale();

      expect(cldr).toBeDefined();
      expect(cldr.numbers).toBeDefined();
    });
  });

  describe('getNumberSymbols', () => {
    it('returns number symbols from CLDR', () => {
      const symbols = getNumberSymbols();

      expect(symbols).toBeDefined();
      expect(symbols.decimal).toBeDefined();
      expect(symbols.group).toBeDefined();
    });
  });

  describe('fetchLocaleMessages', () => {
    it('fetches and returns locale messages', async () => {
      const mockMessages = {
        greeting: { message: 'Hello' }
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        json: () => Promise.resolve(mockMessages)
      });

      const result = await fetchLocaleMessages('en');

      expect(browser.runtime.getURL).toHaveBeenCalledWith('_locales/en/messages.json');
      expect(result).toEqual(mockMessages);
    });

    it('converts locale with hyphen to underscore', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        json: () => Promise.resolve({})
      });

      await fetchLocaleMessages('en-US');

      expect(browser.runtime.getURL).toHaveBeenCalledWith('_locales/en_US/messages.json');
    });

    it('returns null on fetch error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await fetchLocaleMessages('invalid');

      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it('processes placeholders in messages', async () => {
      const mockMessages = {
        greeting: {
          message: 'Hello $name$',
          placeholders: {
            name: { content: '$1' }
          }
        }
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        json: () => Promise.resolve(mockMessages)
      });

      const result = await fetchLocaleMessages('en');

      expect(result?.greeting?.placeholderList).toEqual(['name']);
    });
  });
});
