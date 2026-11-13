import { getPlatformUnlockSupport } from './capabilities';

const original = Object.getOwnPropertyDescriptor(navigator, 'userAgentData');
const target = process.env.TARGET_BROWSER;
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'userAgentData', original);
  else Reflect.deleteProperty(navigator, 'userAgentData');
  if (target === undefined) delete process.env.TARGET_BROWSER;
  else process.env.TARGET_BROWSER = target;
});

it.each([
  ['macOS', '15.0.0', '140', true], ['macOS', '26.6.2', '155', true],
  ['macOS', '14.7.0', '155', false], ['macOS', '15.0.0', '139', false],
  ['Windows', '13.0.0', '140', true], ['Windows', '12.0.0', '155', false],
  ['Linux', '6.0.0', '155', false], ['Chrome OS', '15.0.0', '155', false],
  ['macOS', '', '155', false], ['macOS', '15.invalid.0', '155', false],
  ['macOS', '15.0.0', '155.invalid', false]
])('gates %s %s / Chromium %s to %s', async (platform, platformVersion, version, expected) => {
  process.env.TARGET_BROWSER = 'chrome';
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: {
    brands: [{ brand: 'Chromium', version }],
    getHighEntropyValues: async () => ({ platform, platformVersion })
  } });
  await expect(getPlatformUnlockSupport()).resolves.toBe(expected);
});

it.each([undefined, null, {}, { brands: [] }, { brands: [{ brand: 'other', version: '155' }] }])(
  'refuses missing evidence %#', async data => {
    process.env.TARGET_BROWSER = 'chrome';
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: data });
    await expect(getPlatformUnlockSupport()).resolves.toBe(false);
  }
);

it('refuses unavailable entropy and non-Chrome builds', async () => {
  process.env.TARGET_BROWSER = 'chrome';
  Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: {
    brands: [{ brand: 'Chromium', version: '155' }],
    getHighEntropyValues: async () => { throw new Error('denied'); }
  } });
  await expect(getPlatformUnlockSupport()).resolves.toBe(false);
  process.env.TARGET_BROWSER = 'firefox';
  await expect(getPlatformUnlockSupport()).resolves.toBe(false);
});
