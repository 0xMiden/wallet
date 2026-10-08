/**
 * @jest-environment node
 */
import {
  bundledGridCardCount,
  DappBrowserDriver,
  type DappBrowserState,
  type DappDriverTarget
} from './dapp-browser-driver';
import { runDappBrowserJourney } from './dapp-browser-scenario';
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
      toMatch: (pattern: RegExp) => check(pattern.test(String(actual)), `to match ${pattern}`),
      toHaveLength: (length: number) =>
        check(Array.isArray(actual) && actual.length === length, `to have length ${length}`),
      toBeNull: () => check(actual === null, 'to be null'),
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

describe('DappBrowserDriver curated grid', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A driver over a page whose grid holds each entry of `grids` in turn, one per read, on a clock only its delays move.
  function gridDriver(grids: string[][]): {
    driver: DappBrowserDriver;
    server: DappFixtureServer;
    reads: () => number;
  } {
    let now = 0;
    let reads = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const target: DappDriverTarget = {
      evalJs: async () => JSON.parse(JSON.stringify(grids[Math.min(reads++, grids.length - 1)])),
      click: async () => undefined,
      waitFor: async () => undefined,
      screenshot: async () => undefined,
      navigateTo: async () => undefined,
      delay: async ms => {
        now += ms;
      }
    };
    const server: DappFixtureServer = {
      port: 0,
      urlFor: () => '',
      lastReport: () => report(1),
      reports: () => [],
      reset: () => undefined,
      loadCount: () => 0,
      stop: async () => undefined
    };
    const driver = new DappBrowserDriver({ target, server, artifactDir: '/tmp/dapp-driver-test', label: 'test' });
    return { driver, server, reads: () => reads };
  }

  it('waits for the catalog to land instead of reading the grid once', async () => {
    const both = ['https://faucet.example/', 'https://forkchoice.example/'];
    const { driver, reads } = gridDriver([[], ['https://faucet.example/'], both]);

    await expect(driver.waitForGridCards(2)).resolves.toEqual(both);
    expect(reads()).toBe(3);
  });

  it('names what it last saw when the grid never fills', async () => {
    const { driver } = gridDriver([['https://faucet.example/']]);

    await expect(driver.waitForGridCards(2)).rejects.toThrow(
      /at least 2 curated grid cards\. last value: \["https:\/\/faucet\.example\/"\]/
    );
  });

  it("passes the journey's grid step on the one row devnet's bundled catalog draws", async () => {
    const saved = process.env.E2E_NETWORK;
    process.env.E2E_NETWORK = 'devnet';
    const { driver, server } = gridDriver([['https://faucet.example/']]);
    jest.spyOn(driver, 'gotoBrowserTab').mockResolvedValue();
    jest.spyOn(driver, 'state').mockResolvedValue({ ...STATE, foregroundId: null, sessions: [] });
    const ran: string[] = [];
    const steps = {
      outputDir: '/tmp/dapp-driver-test',
      step: async (name: string, fn: () => Promise<void>) => {
        if (ran.length > 0) throw new Error('only the grid step runs here');
        ran.push(name);
        await fn();
      }
    };
    try {
      await expect(runDappBrowserJourney({ driver, server, steps })).rejects.toThrow('only the grid step runs here');
      expect(ran).toEqual(['launcher_renders_curated_grid']);
    } finally {
      if (saved === undefined) delete process.env.E2E_NETWORK;
      else process.env.E2E_NETWORK = saved;
    }
  });
});

describe('bundledGridCardCount', () => {
  const saved = process.env.E2E_NETWORK;
  afterEach(() => {
    if (saved === undefined) delete process.env.E2E_NETWORK;
    else process.env.E2E_NETWORK = saved;
  });

  it("counts the rows the E2E network's bundled catalog draws in its lists, testnet when none is named", () => {
    process.env.E2E_NETWORK = 'devnet';
    expect(bundledGridCardCount()).toBe(1);
    delete process.env.E2E_NETWORK;
    expect(bundledGridCardCount()).toBe(2);
  });
});
