import { browserLaunchOptions } from '../fixtures/browser-launch-options';

const EXTENSION = '/tmp/dist/chrome_unpacked';

describe('browserLaunchOptions', () => {
  it('launches headed with the extension by default, as CI runs it under xvfb', () => {
    const options = browserLaunchOptions(EXTENSION, {});
    expect(options).toMatchObject({ headless: false, ignoreDefaultArgs: ['--disable-extensions'] });
    expect(options).not.toHaveProperty('channel');
    expect(options.args).toEqual(
      expect.arrayContaining([`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`])
    );
    expect(options.args.some(arg => arg.startsWith('--screen-info'))).toBe(false);
  });

  // The default headless shell never loads an extension; the full Chromium build in new headless mode does.
  it('goes headless on the full Chromium build with a screen large enough for confirm popups when asked', () => {
    const options = browserLaunchOptions(EXTENSION, { E2E_HEADLESS: '1' });
    expect(options).toMatchObject({ headless: true, channel: 'chromium' });
    expect(options.args).toEqual(
      expect.arrayContaining([`--load-extension=${EXTENSION}`, '--screen-info={1600x1200}'])
    );
  });

  it('stays headed for any other value', () => {
    for (const value of ['0', '', 'false', 'yes']) {
      expect(browserLaunchOptions(EXTENSION, { E2E_HEADLESS: value }).headless).toBe(false);
    }
  });
});
