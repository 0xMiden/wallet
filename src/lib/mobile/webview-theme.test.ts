import { THEME_STORAGE_KEY } from 'lib/settings/constants';

import { webviewToolbarColors } from './webview-theme';

function phonePrefersDark(dark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: dark && query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn()
    })
  });
}

describe('webviewToolbarColors', () => {
  afterEach(() => localStorage.clear());

  it('paints the header dark when the app is dark, whatever the phone prefers', () => {
    phonePrefersDark(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(webviewToolbarColors()).toStrictEqual({ toolbarColor: '#191919' });
  });

  it('paints the header light when the app is light, whatever the phone prefers', () => {
    phonePrefersDark(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(webviewToolbarColors()).toStrictEqual({ toolbarColor: '#ffffff' });
  });

  it('follows the resolved theme when the app follows the system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    phonePrefersDark(true);
    expect(webviewToolbarColors().toolbarColor).toBe('#191919');
    phonePrefersDark(false);
    expect(webviewToolbarColors().toolbarColor).toBe('#ffffff');
  });
});
