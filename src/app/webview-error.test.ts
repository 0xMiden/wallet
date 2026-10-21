import fs from 'fs';
import path from 'path';

import config from '../../capacitor.config';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.google.android.webview';
const CHROME_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.android.chrome';
// Android 7 to 9 take Chrome as their WebView whenever it is enabled; Android 10 and later take Android System WebView.
const OLD_ANDROID_9 =
  'Mozilla/5.0 (Linux; Android 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36';
const OLD_ANDROID = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/92.0.4515.159 Mobile Safari/537.36';
const NEW_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.6099.230 Mobile Safari/537.36';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
// The page cannot import the wallet's config, strings or locale list, so it keeps copies, and these cases compare each
// copy with its source.
const EN: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(PUBLIC_DIR, '_locales', 'en', 'en.json'), 'utf8')
);
function en(key: string): string {
  const message = EN[key];
  if (message === undefined) throw new Error(`en.json has no ${key}`);
  return message;
}
const MIN_WEBVIEW = config.android?.minWebViewVersion ?? 0;
const LOCALE_DIRECTORIES = fs
  .readdirSync(path.join(PUBLIC_DIR, '_locales'))
  .filter(directory => fs.existsSync(path.join(PUBLIC_DIR, '_locales', directory, 'messages.json')));

type LocaleResponse = { status: number; body: string };
let localeResponses: Record<string, LocaleResponse>;

class LocaleRequest {
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static urls: string[] = [];
  private url = '';

  open(_method: string, url: string) {
    this.url = url;
    LocaleRequest.urls.push(url);
  }

  send() {
    const response = localeResponses[this.url];
    if (!response) {
      this.onerror?.();
      return;
    }
    this.status = response.status;
    this.responseText = response.body;
    this.onload?.();
  }
}

// The page renders once, from the navigator it loads under, so each case sets the navigator and then loads the script.
function load(userAgent: string, language: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => userAgent });
  Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => language });
  const script = document.createElement('script');
  script.textContent = fs.readFileSync(path.join(PUBLIC_DIR, 'webview-error.js'), 'utf8');
  document.body.appendChild(script);
}

describe('WebView error page', () => {
  const originalXMLHttpRequest = window.XMLHttpRequest;
  const originalTitle = document.title;
  const originalLanguage = document.documentElement.lang;

  beforeEach(() => {
    localeResponses = {};
    LocaleRequest.urls = [];
    Object.defineProperty(window, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: LocaleRequest
    });
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'webview-error.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(window, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: originalXMLHttpRequest
    });
    delete (window.navigator as { userAgent?: string }).userAgent;
    delete (window.navigator as { language?: string }).language;
    document.body.innerHTML = '';
    document.title = originalTitle;
    document.documentElement.lang = originalLanguage;
  });

  it('ships the start-failed copy of en.json as its static text', () => {
    expect(document.getElementById('title')).toHaveTextContent(en('webViewStartFailedTitle'));
    expect(document.getElementById('body')).toHaveTextContent(en('webViewStartFailedBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewStartFailedAction'));
  });

  it.each(LOCALE_DIRECTORIES)('requests the shipped %s locale for its own language tag', directory => {
    load(OLD_ANDROID, directory.replace('_', '-'));

    expect(LocaleRequest.urls).toEqual([`/_locales/${directory}/messages.json`]);
  });

  it('renders once and leaves no renderer on the page', () => {
    load(OLD_ANDROID, 'en-US');

    expect((window as { __webviewErrorRender?: unknown }).__webviewErrorRender).toBeUndefined();
  });

  it('sends Chrome 92 to the WebView update listing when the locale request fails', () => {
    load(OLD_ANDROID, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent(en('webViewUpdateTitle'));
    expect(document.getElementById('body')).toHaveTextContent(en('webViewUpdateBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewUpdateAction'));
    expect(document.getElementById('action')).toHaveAttribute('href', PLAY_URL);
  });

  it('sends Android 9, whose WebView is Chrome, to the Chrome update listing', () => {
    load(OLD_ANDROID_9, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent(en('webViewUpdateChromeTitle'));
    expect(document.getElementById('body')).toHaveTextContent(en('webViewUpdateChromeBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewUpdateAction'));
    expect(document.getElementById('action')).toHaveAttribute('href', CHROME_PLAY_URL);
  });

  it.each([OLD_ANDROID, 'Mozilla/5.0 (Linux) AppleWebKit/537.36 Chrome/92.0.4515.159 Mobile Safari/537.36'])(
    'keeps the WebView update listing on Android 10 and when no Android version is named: %s',
    userAgent => {
      load(userAgent, 'en-US');

      expect(document.getElementById('title')).toHaveTextContent(en('webViewUpdateTitle'));
      expect(document.getElementById('action')).toHaveAttribute('href', PLAY_URL);
    }
  );

  it('localizes the Chrome update copy', () => {
    localeResponses['/_locales/de/messages.json'] = {
      status: 200,
      body: JSON.stringify({
        webViewUpdateChromeTitle: { message: 'Chrome aktualisieren' },
        webViewUpdateChromeBody: { message: 'Bread braucht ein neueres Chrome.' },
        webViewUpdateAction: { message: 'Google Play öffnen' }
      })
    };

    load(OLD_ANDROID_9, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Chrome aktualisieren');
    expect(document.getElementById('body')).toHaveTextContent('Bread braucht ein neueres Chrome.');
    expect(document.getElementById('action')).toHaveTextContent('Google Play öffnen');
    expect(document.getElementById('action')).toHaveAttribute('href', CHROME_PLAY_URL);
  });

  it.each([NEW_ANDROID, IOS])('offers a startup retry for a supported or non-Chrome WebView: %s', userAgent => {
    load(userAgent, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent(en('webViewStartFailedTitle'));
    expect(document.getElementById('body')).toHaveTextContent(en('webViewStartFailedBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewStartFailedAction'));
    expect(document.getElementById('action')).toHaveAttribute('href', '/');
  });

  it.each([
    { major: MIN_WEBVIEW - 1, title: en('webViewUpdateTitle'), href: PLAY_URL },
    { major: MIN_WEBVIEW, title: en('webViewStartFailedTitle'), href: '/' }
  ])('enforces the minWebViewVersion boundary at Chrome $major', ({ major, title, href }) => {
    load(`Mozilla/5.0 (Linux; Android 10) Chrome/${major}.0.0.0 Mobile Safari/537.36`, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent(title);
    expect(document.getElementById('action')).toHaveAttribute('href', href);
  });

  it('uses the German locale directory and keeps English for missing keys', () => {
    localeResponses['/_locales/de/messages.json'] = {
      status: 200,
      body: JSON.stringify({ webViewUpdateTitle: { message: 'Android System WebView aktualisieren' } })
    };

    load(OLD_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Android System WebView aktualisieren');
    expect(document.getElementById('body')).toHaveTextContent(en('webViewUpdateBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewUpdateAction'));
    expect(document.getElementById('action')).toHaveAttribute('href', PLAY_URL);
  });

  it.each([
    ['en-GB', 'en_GB'],
    ['zh-CN', 'zh_CN'],
    ['zh-TW', 'zh_TW'],
    ['zh-Hant-TW', 'zh_TW'],
    ['xx-XX', 'en']
  ])('resolves %s to the shipped %s locale', (language, directory) => {
    localeResponses[`/_locales/${directory}/messages.json`] = {
      status: 200,
      body: JSON.stringify({ webViewUpdateTitle: { message: 'Localized update title' } })
    };

    load(OLD_ANDROID, language);

    expect(document.getElementById('title')).toHaveTextContent('Localized update title');
  });

  it('localizes the generic retry without changing its destination', () => {
    localeResponses['/_locales/de/messages.json'] = {
      status: 200,
      body: JSON.stringify({
        webViewStartFailedTitle: { message: 'Bread konnte nicht starten' },
        webViewStartFailedBody: { message: 'Bread erneut starten.' },
        webViewStartFailedAction: { message: 'Erneut versuchen' }
      })
    };

    load(NEW_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Bread konnte nicht starten');
    expect(document.getElementById('body')).toHaveTextContent('Bread erneut starten.');
    expect(document.getElementById('action')).toHaveTextContent('Erneut versuchen');
    expect(document.getElementById('action')).toHaveAttribute('href', '/');
  });

  it.each([
    { status: 404, body: '{"webViewUpdateTitle":{"message":"Unavailable translation"}}' },
    { status: 200, body: 'invalid json' },
    { status: 200, body: 'null' },
    { status: 200, body: '{"webViewUpdateTitle":{"message":42},"webViewUpdateAction":{"message":""}}' }
  ])('keeps English when a locale response is unusable: %j', response => {
    localeResponses['/_locales/de/messages.json'] = response;

    load(OLD_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent(en('webViewUpdateTitle'));
    expect(document.getElementById('body')).toHaveTextContent(en('webViewUpdateBody'));
    expect(document.getElementById('action')).toHaveTextContent(en('webViewUpdateAction'));
    expect(document.getElementById('action')).toHaveAttribute('href', PLAY_URL);
  });
});

describe('Capacitor WebView gate', () => {
  it('requires WebView 98 and points to the bundled error page', () => {
    expect(config.android?.minWebViewVersion).toBe(98);
    expect(config.server?.errorPath).toBe('webview-error.html');
    expect(fs.existsSync(path.join(PUBLIC_DIR, 'webview-error.html'))).toBe(true);
  });
});
