/**
 * @jest-environment node
 */
import { DappBrowserDriver, type DappBrowserState, type DappDriverTarget } from './dapp-browser-driver';
import { GENERATION_COLORS, type DappFixtureServer, type DappViewportReport } from './dapp-fixture-server';
import type { RegionStats } from './dapp-visual';

const mockSampleRegion = jest.fn();

// Playwright's expect puts its second argument on the failure, which is what these tests assert on.
jest.mock('@playwright/test', () => ({
  expect: (actual: unknown, message = '') => {
    const check = (pass: boolean, claim: string): void => {
      if (!pass) throw new Error(`${message}\nexpected ${String(actual)} ${claim}`);
    };
    return {
      toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
      toBeLessThan: (bound: number) => check(Number(actual) < bound, `to be less than ${bound}`),
      toBeGreaterThan: (bound: number) => check(Number(actual) > bound, `to be greater than ${bound}`),
      not: { toBeNull: () => check(actual !== null, 'not to be null') }
    };
  }
}));
jest.mock('./dapp-visual', () => ({
  sampleRegion: (...args: unknown[]) => mockSampleRegion(...args),
  measureVerticalOffsetCss: async () => 0,
  describeStats: (s: { matchFraction: number; blankFraction: number }) =>
    `match=${Math.round(s.matchFraction * 100)}% blank=${Math.round(s.blankFraction * 100)}%`
}));

const STATE: DappBrowserState = {
  foregroundId: 'dapp-beta',
  mode: 'active',
  switcherOpen: false,
  slotRect: { x: 0, y: 100, width: 400, height: 600 },
  sessions: []
};
const VIEWPORT = { width: 400, height: 800 };
const TILE = { x: 0, y: 0, width: 100, height: 100 };

function stats(matchFraction: number, blankFraction: number): RegionStats {
  return { matchFraction, blankFraction, mean: [0, 0, 0], sampled: { x: 0, y: 0, width: 10, height: 10 } };
}

function report(seq: number): DappViewportReport {
  return { id: 'beta', width: 400, height: 600, devicePixelRatio: 3, seq, reason: 'visible', at: 0 };
}

/**
 * A driver over a fake page on a simulated clock that only the driver's own delays advance, and a fixture server
 * whose report count follows `seqs`, one entry per read.
 */
function driverWith(seqs: number[]): { driver: DappBrowserDriver; shots: string[]; elapsed: () => number } {
  const shots: string[] = [];
  let now = 0;
  let reads = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const target: DappDriverTarget = {
    // The real target hands back what the page serialised, so the fake crosses the same JSON boundary.
    evalJs: async js => JSON.parse(JSON.stringify(js.includes('__TEST_DAPP_BROWSER__') ? STATE : VIEWPORT)),
    click: async () => undefined,
    waitFor: async () => undefined,
    screenshot: async ({ path }) => {
      shots.push(path);
    },
    navigateTo: async () => undefined,
    delay: async ms => {
      now += ms;
    }
  };
  const server: DappFixtureServer = {
    port: 0,
    urlFor: () => '',
    lastReport: () => report(seqs[Math.min(reads++, seqs.length - 1)] ?? 1),
    reports: () => [],
    reset: () => undefined,
    loadCount: () => 0,
    stop: async () => undefined
  };
  const driver = new DappBrowserDriver({ target, server, artifactDir: '/tmp/dapp-driver-test', label: 'test' });
  return { driver, shots, elapsed: () => now };
}

describe('DappBrowserDriver screenshot checks', () => {
  beforeEach(() => {
    mockSampleRegion.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-captures a peek tile that is still blank until it paints', async () => {
    const { driver, shots } = driverWith([1]);
    mockSampleRegion.mockResolvedValueOnce(stats(0, 1)).mockResolvedValueOnce(stats(0, 0.2));

    await driver.expectRegionNotBlank(TILE, 'peek-tile');

    expect(shots).toHaveLength(2);
    expect(shots[1]).toContain('peek-tile-settle2');
  });

  it('fails a region that is still blank once the settle budget is spent', async () => {
    const { driver, elapsed } = driverWith([1]);
    mockSampleRegion.mockResolvedValue(stats(0, 1));

    await expect(driver.expectRegionNotBlank(TILE, 'peek-tile')).rejects.toThrow('region is blank');
    expect(elapsed()).toBe(5_000);
  });

  it('re-captures a dApp slot until it shows the dApp', async () => {
    const { driver, shots } = driverWith([1]);
    mockSampleRegion.mockResolvedValueOnce(stats(0, 0.9)).mockResolvedValueOnce(stats(0.95, 0));

    await driver.expectDappPainted('beta', 'beta-foreground');

    expect(shots).toHaveLength(2);
  });

  it('waits for a report the page painted before the server received it', async () => {
    // The screen already shows generation 2 while the server has recorded only report 1.
    const { driver, shots } = driverWith([1, 1, 2]);
    const generationTwo = JSON.stringify(GENERATION_COLORS[1]);
    mockSampleRegion.mockImplementation(async (...args: unknown[]) =>
      stats(JSON.stringify(args[3]) === generationTwo ? 0.95 : 0, 0)
    );

    await driver.expectFreshFrame('beta', 'beta-restored');

    expect(shots).toHaveLength(2);
    expect(shots[1]).toContain('beta-restored-generation-settle2');
  });

  it('fails a frame that never catches up with the latest report', async () => {
    const { driver, elapsed } = driverWith([3]);
    mockSampleRegion.mockResolvedValue(stats(0, 0));

    await expect(driver.expectFreshFrame('beta', 'beta-restored')).rejects.toThrow('STALE frame');
    expect(elapsed()).toBe(5_000);
  });
});
