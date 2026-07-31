// `browser-info.ts` computes `browserInfo` and `isSafeBrowserVersion` in
// module-scope IIFEs that read `navigator.userAgent` / `appName` / `appVersion`
// at import time. To exercise every branch we override the navigator fields and
// re-`require` the module (jsdom + resetModules pattern used elsewhere in this
// repo, e.g. `lib/platform/index.test.ts`).

const setNavigator = (fields: { userAgent: string; appName?: string; appVersion?: string }) => {
  Object.defineProperty(navigator, 'userAgent', { value: fields.userAgent, configurable: true });
  if (fields.appName !== undefined) {
    Object.defineProperty(navigator, 'appName', { value: fields.appName, configurable: true });
  }
  if (fields.appVersion !== undefined) {
    Object.defineProperty(navigator, 'appVersion', { value: fields.appVersion, configurable: true });
  }
};

const loadWith = (fields: { userAgent: string; appName?: string; appVersion?: string }): boolean => {
  jest.resetModules();
  setNavigator(fields);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./browser-info') as { isSafeBrowserVersion: boolean }).isSafeBrowserVersion;
};

const CHROME_93 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36';
const CHROME_90 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36';
const FIREFOX_88 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0';
const SAFARI_15 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15';
const SAFARI_IOS_11 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1';
const IE_11 = 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko';
const IE_NO_RV = 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)';
const OPERA_72 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36 OPR/72.0.3815.148';
const EDGE_16 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36 Edge/16.16299';
const UNKNOWN_UA = 'SomeRandomBot/1.0';

describe('isSafeBrowserVersion', () => {
  const original = {
    userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
    appName: Object.getOwnPropertyDescriptor(navigator, 'appName'),
    appVersion: Object.getOwnPropertyDescriptor(navigator, 'appVersion')
  };

  afterAll(() => {
    if (original.userAgent) Object.defineProperty(navigator, 'userAgent', original.userAgent);
    if (original.appName) Object.defineProperty(navigator, 'appName', original.appName);
    if (original.appVersion) Object.defineProperty(navigator, 'appVersion', original.appVersion);
  });

  describe('Chrome', () => {
    it('is safe at the minimum secure version (93)', () => {
      expect(loadWith({ userAgent: CHROME_93 })).toBe(true);
    });

    it('is unsafe below the minimum secure version (90 < 93)', () => {
      expect(loadWith({ userAgent: CHROME_90 })).toBe(false);
    });
  });

  describe('Firefox', () => {
    it('is safe at the minimum secure version (88)', () => {
      expect(loadWith({ userAgent: FIREFOX_88 })).toBe(true);
    });
  });

  describe('Safari', () => {
    it('is safe when the Version/ token is at/above the minimum (15 >= 12)', () => {
      expect(loadWith({ userAgent: SAFARI_15 })).toBe(true);
    });

    it('is unsafe when the Version/ token is below the minimum (11 < 12)', () => {
      // The engine token "Safari/604" would parse to 604 (safe); the Version/11
      // override is what makes this correctly unsafe, so `false` proves the
      // `version/(\d+)` override path is taken.
      expect(loadWith({ userAgent: SAFARI_IOS_11 })).toBe(false);
    });
  });

  describe('Internet Explorer / Trident', () => {
    it('is safe when rv token is present and meets the minimum (IE 11)', () => {
      // Only the Trident->IE + rv-extraction path can yield name "IE"; a `true`
      // here proves both the trident branch and the `rv[ :]+(\d+)` extraction.
      expect(loadWith({ userAgent: IE_11 })).toBe(true);
    });

    it('is unsafe when the rv token is missing (version resolves to empty)', () => {
      // Trident without an `rv:` token -> version '' -> parseInt('') is NaN,
      // and `NaN >= 11` is false.
      expect(loadWith({ userAgent: IE_NO_RV })).toBe(false);
    });

    it('falls back to an empty version when a Trident UA has no rv token', () => {
      // Engine resolves to "Trident" (so the trident->IE branch is taken) but
      // `/rv[ :]+(\d+)/` finds nothing, so `tem` is null and version comes from
      // the `tem?.[1] ?? ''` fallback -> parseInt('') is NaN -> unsafe.
      expect(loadWith({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Trident/7.0) like Gecko' })).toBe(false);
    });
  });

  describe('Chromium-based re-brands', () => {
    it('maps OPR/ to Opera and is safe at the minimum (72)', () => {
      // secureBrowserVersions has no "OPR" key, so a `true` result proves the
      // "OPR" -> "Opera" rename happened before the lookup.
      expect(loadWith({ userAgent: OPERA_72 })).toBe(true);
    });

    it('detects Edge/ and is safe at the minimum (16)', () => {
      expect(loadWith({ userAgent: EDGE_16 })).toBe(true);
    });
  });

  describe('unknown / unmatched user agents', () => {
    it('is unsafe when the UA matches no known engine (appName/appVersion fallback)', () => {
      // No engine match -> falls back to navigator.appName ("Netscape"), which
      // is absent from the secure-version table -> minVersion undefined -> false.
      expect(loadWith({ userAgent: UNKNOWN_UA, appName: 'Netscape', appVersion: '5.0 (Windows)' })).toBe(false);
    });
  });
});
