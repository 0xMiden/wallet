import fs from 'fs';
import path from 'path';

import config from '../../capacitor.config';

declare global {
  interface Window {
    __webviewErrorRender?: (userAgent: string, language: string) => void;
  }
}

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.google.android.webview';
const OLD_ANDROID = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/92.0.4515.159 Mobile Safari/537.36';
const NEW_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.6099.230 Mobile Safari/537.36';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const UPDATE_BODY =
  'Bread needs a newer version of Android System WebView, the part of Android that shows web pages in apps. Update it from Google Play, then open Bread again.';
const START_FAILED_BODY = 'Something stopped Bread from loading. Try again, or close Bread and open it again.';

type LocaleResponse = { status: number; body: string };
let localeResponses: Record<string, LocaleResponse>;

class LocaleRequest {
  status = 0;
  responseText = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';

  open(_method: string, url: string) {
    this.url = url;
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

describe('WebView error page', () => {
  const originalXMLHttpRequest = window.XMLHttpRequest;
  const originalTitle = document.title;
  const originalLanguage = document.documentElement.lang;
  let render: (userAgent: string, language: string) => void;

  beforeEach(() => {
    localeResponses = {};
    Object.defineProperty(window, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: LocaleRequest
    });
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'webview-error.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    const script = document.createElement('script');
    script.textContent = fs.readFileSync(path.join(PUBLIC_DIR, 'webview-error.js'), 'utf8');
    document.body.appendChild(script);
    const loadedRender = window.__webviewErrorRender;
    if (!loadedRender) throw new Error('The WebView error script did not expose render');
    render = loadedRender;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(window, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: originalXMLHttpRequest
    });
    delete window.__webviewErrorRender;
    document.body.innerHTML = '';
    document.title = originalTitle;
    document.documentElement.lang = originalLanguage;
  });

  it('sends Chrome 92 to the WebView update listing when the locale request fails', () => {
    render(OLD_ANDROID, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent('Update Android System WebView');
    expect(document.getElementById('body')).toHaveTextContent(UPDATE_BODY);
    expect(document.getElementById('action')).toHaveTextContent('Open Google Play');
    expect(document.getElementById('action')).toHaveAttribute('href', PLAY_URL);
  });

  it.each([NEW_ANDROID, IOS])('offers a startup retry for a supported or non-Chrome WebView: %s', userAgent => {
    render(userAgent, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent("Bread couldn't start");
    expect(document.getElementById('body')).toHaveTextContent(START_FAILED_BODY);
    expect(document.getElementById('action')).toHaveTextContent('Try again');
    expect(document.getElementById('action')).toHaveAttribute('href', '/');
  });

  it.each([
    { major: 97, title: 'Update Android System WebView', href: PLAY_URL },
    { major: 98, title: "Bread couldn't start", href: '/' }
  ])('enforces the version boundary at Chrome $major', ({ major, title, href }) => {
    render(`Mozilla/5.0 (Linux; Android 10) Chrome/${major}.0.0.0 Mobile Safari/537.36`, 'en-US');

    expect(document.getElementById('title')).toHaveTextContent(title);
    expect(document.getElementById('action')).toHaveAttribute('href', href);
  });

  it('uses the German locale directory and keeps English for missing keys', () => {
    localeResponses['/_locales/de/messages.json'] = {
      status: 200,
      body: JSON.stringify({ webViewUpdateTitle: { message: 'Android System WebView aktualisieren' } })
    };

    render(OLD_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Android System WebView aktualisieren');
    expect(document.getElementById('body')).toHaveTextContent(UPDATE_BODY);
    expect(document.getElementById('action')).toHaveTextContent('Open Google Play');
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

    render(OLD_ANDROID, language);

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

    render(NEW_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Bread konnte nicht starten');
    expect(document.getElementById('body')).toHaveTextContent('Bread erneut starten.');
    expect(document.getElementById('action')).toHaveTextContent('Erneut versuchen');
    expect(document.getElementById('action')).toHaveAttribute('href', '/');
  });

  it('ignores an earlier locale response after rendering a different recovery action', () => {
    const requests: LocaleRequest[] = [];
    jest.spyOn(LocaleRequest.prototype, 'send').mockImplementation(function (this: LocaleRequest) {
      requests.push(this);
    });

    render(OLD_ANDROID, 'de-DE');
    render(NEW_ANDROID, 'en-US');
    const [earlier] = requests;
    if (!earlier) throw new Error('The first render made no locale request');
    earlier.status = 200;
    earlier.responseText = JSON.stringify({ webViewUpdateTitle: { message: 'Outdated update title' } });
    earlier.onload?.();

    expect(document.getElementById('title')).toHaveTextContent("Bread couldn't start");
    expect(document.getElementById('action')).toHaveTextContent('Try again');
    expect(document.getElementById('action')).toHaveAttribute('href', '/');
  });

  it.each([
    { status: 404, body: '{"webViewUpdateTitle":{"message":"Unavailable translation"}}' },
    { status: 200, body: 'invalid json' },
    { status: 200, body: 'null' },
    { status: 200, body: '{"webViewUpdateTitle":{"message":42},"webViewUpdateAction":{"message":""}}' }
  ])('keeps English when a locale response is unusable: %j', response => {
    localeResponses['/_locales/de/messages.json'] = response;

    render(OLD_ANDROID, 'de-DE');

    expect(document.getElementById('title')).toHaveTextContent('Update Android System WebView');
    expect(document.getElementById('body')).toHaveTextContent(UPDATE_BODY);
    expect(document.getElementById('action')).toHaveTextContent('Open Google Play');
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
