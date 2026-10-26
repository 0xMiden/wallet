import {
  buildClickAcceptAllScript,
  buildPendingSampleScript,
  claimFromPendingList,
  clickFirstAcceptAll,
  drainPendingClaims,
  isDrained,
  type DrainDriver,
  type MobileClaimPage,
  type PendingSample
} from './claim-drain';
import { ACTIVITY_PENDING_PATH } from '../../../src/app/pages/activity-paths';

/** Runs an emitted body the way `cdp.eval` does, against the jsdom document and location. */
function run<T>(script: string): T {
  return new Function(script)() as T;
}

function show(hash: string, html: string): void {
  window.location.hash = hash;
  document.body.innerHTML = html;
}

const PENDING = '#/history?filter=pending&view=list';
// A card and one of its titled parts: the parts carry suffixed ids and must not count as cards.
const CARD =
  '<div data-testid="pending-activity-row"><span data-testid="pending-activity-row-title">Received</span></div>';

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('buildPendingSampleScript', () => {
  it('reads an empty, settled Pending list as drained', () => {
    show(PENDING, '<div></div>');
    expect(run<PendingSample>(buildPendingSampleScript())).toEqual({
      onPending: true,
      rows: 0,
      acceptAll: 'absent',
      loading: false
    });
  });

  it('counts each card once, not its titled parts', () => {
    show(PENDING, CARD + CARD);
    expect(run<PendingSample>(buildPendingSampleScript()).rows).toBe(2);
  });

  it.each([
    ['idle', '<button data-testid="pending-row-accept-all">Accept all</button>'],
    ['busy', '<button data-testid="pending-row-accept-all" aria-busy="true">Accepting</button>'],
    ['busy', '<button data-testid="pending-row-accept-all" disabled>Accept all</button>'],
    ['busy', '<button data-testid="pending-row-accept-all" aria-disabled="true">Accept all</button>']
  ])('reads Accept All as %s from %s', (state, html) => {
    show(PENDING, html);
    expect(run<PendingSample>(buildPendingSampleScript()).acceptAll).toBe(state);
  });

  it('reports the claims loading bar', () => {
    show(PENDING, '<div role="progressbar" aria-label="Loading"></div>');
    expect(run<PendingSample>(buildPendingSampleScript()).loading).toBe(true);
  });

  it.each([
    ['#/history?filter=pending&view=list', true],
    ['#/history?view=list&filter=pending', true],
    ['#/history?filter=all', false],
    ['#/history', false],
    ['#/', false],
    ['#/generating-transaction/abc?filter=pending', false]
  ])('treats %s as the Pending list: %s', (hash, expected) => {
    show(hash, '');
    expect(run<PendingSample>(buildPendingSampleScript()).onPending).toBe(expected);
  });
});

describe('buildClickAcceptAllScript', () => {
  it('clicks an idle Accept All and says so', () => {
    show(PENDING, '<button data-testid="pending-row-accept-all">Accept all</button>');
    const onClick = jest.fn();
    document.querySelector('button')?.addEventListener('click', onClick);
    expect(run<boolean>(buildClickAcceptAllScript())).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('leaves a busy Accept All alone', () => {
    show(PENDING, '<button data-testid="pending-row-accept-all" aria-busy="true">Accepting</button>');
    const onClick = jest.fn();
    document.querySelector('button')?.addEventListener('click', onClick);
    expect(run<boolean>(buildClickAcceptAllScript())).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('answers false when there is no Accept All', () => {
    show(PENDING, '');
    expect(run<boolean>(buildClickAcceptAllScript())).toBe(false);
  });
});

describe('isDrained', () => {
  const drained: PendingSample = { onPending: true, rows: 0, acceptAll: 'absent', loading: false };

  it('holds for a settled, empty Pending list', () => {
    expect(isDrained(drained)).toBe(true);
  });

  it.each<[string, Partial<PendingSample>]>([
    ['off the Pending list', { onPending: false }],
    ['a card still listed', { rows: 1 }],
    ['Accept All idle', { acceptAll: 'idle' }],
    ['Accept All busy', { acceptAll: 'busy' }],
    ['notes still loading', { loading: true }]
  ])('fails with %s', (_, change) => {
    expect(isDrained({ ...drained, ...change })).toBe(false);
  });
});

const drained: PendingSample = { onPending: true, rows: 0, acceptAll: 'absent', loading: false };
const claiming: PendingSample = { onPending: true, rows: 1, acceptAll: 'busy', loading: false };
const waiting: PendingSample = { onPending: true, rows: 1, acceptAll: 'idle', loading: false };
const loadingEmpty: PendingSample = { onPending: true, rows: 0, acceptAll: 'absent', loading: true };
const elsewhere: PendingSample = { onPending: false, rows: 0, acceptAll: 'absent', loading: false };

/**
 * A driver over a scripted run of reads and click answers (the last of each repeats) and a clock only
 * sync and sleep move.
 */
function fakeDriver(
  reads: Array<PendingSample | Error>,
  clickLands: boolean | boolean[] = true,
  overrides?: { onLapThrow?: Error; clickThrow?: Error; openThrow?: Error }
) {
  let now = 0;
  let next = 0;
  const calls = { samples: 0, clicks: 0, reopens: 0, sampleTimes: new Array<number>() };
  const driver: DrainDriver = {
    sample: async (): Promise<PendingSample> => {
      calls.samples++;
      calls.sampleTimes.push(now);
      const read = reads[Math.min(next++, reads.length - 1)];
      if (read === undefined) throw new Error('fake driver ran out of reads');
      if (read instanceof Error) throw read;
      return read;
    },
    clickAcceptAll: async () => {
      const answer = Array.isArray(clickLands) ? clickLands[Math.min(calls.clicks, clickLands.length - 1)] : clickLands;
      calls.clicks++;
      if (overrides?.clickThrow) throw overrides.clickThrow;
      return answer === true;
    },
    openPending: async () => {
      calls.reopens++;
      if (overrides?.openThrow) throw overrides.openThrow;
    },
    onLap: overrides?.onLapThrow
      ? async () => {
          throw overrides.onLapThrow;
        }
      : undefined,
    sync: async () => {
      now += 3_500;
    },
    sleep: async ms => {
      now += ms;
    },
    now: () => now
  };
  return { driver, calls };
}

describe('drainPendingClaims', () => {
  const options = { timeoutMs: 120_000, label: 'TestPage.claimAllNotes' };

  it('returns once two consecutive reads show the list drained', async () => {
    const { driver, calls } = fakeDriver([claiming, drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.samples).toBe(3);
  });

  it('does not pass on one drained read that a listed card follows', async () => {
    const { driver, calls } = fakeDriver([drained, claiming, drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.samples).toBe(4);
  });

  // The false pass the balance oracle had: nothing here reads a balance, so an account that already
  // holds funds cannot pass while its claim is still listed.
  it('never passes while a claim is still listed', async () => {
    const { driver } = fakeDriver([claiming]);
    await expect(drainPendingClaims(driver, options)).rejects.toThrow(
      'TestPage.claimAllNotes: the Pending list did not drain within 120000ms'
    );
  });

  it('does not count an empty list while notes are still loading', async () => {
    const { driver } = fakeDriver([loadingEmpty]);
    await expect(drainPendingClaims(driver, options)).rejects.toThrow('did not drain');
  });

  it('clicks an idle Accept All while a card waits', async () => {
    const { driver, calls } = fakeDriver([waiting, drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.clicks).toBe(1);
  });

  it('reads the list again one sync after a click', async () => {
    const { driver, calls } = fakeDriver([waiting, drained, drained]);
    await drainPendingClaims(driver, options);
    // One 3_500 sync, the click, then the 3_000 poll spacing and the next lap's sync.
    expect(calls.sampleTimes.slice(0, 2)).toEqual([3_500, 10_000]);
  });

  it('does not click a busy Accept All', async () => {
    const { driver, calls } = fakeDriver([claiming, drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.clicks).toBe(0);
  });

  it('keeps draining when a click finds Accept All already busy', async () => {
    const { driver, calls } = fakeDriver([waiting, waiting, drained, drained], false);
    await drainPendingClaims(driver, options);
    expect(calls.clicks).toBe(2);
  });

  it('reopens the Pending list when the wallet left it, and that lap does not count', async () => {
    const { driver, calls } = fakeDriver([drained, elsewhere, drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.reopens).toBe(1);
    expect(calls.samples).toBe(4);
  });

  it('a read that throws counts as not drained', async () => {
    const { driver, calls } = fakeDriver([drained, new Error('cdp eval failed'), drained, drained]);
    await drainPendingClaims(driver, options);
    expect(calls.samples).toBe(4);
  });

  // A 4 s budget ends after one lap with a streak of one: the lap that overran the deadline drained.
  it('passes at the deadline on two fresh drained reads', async () => {
    const { driver, calls } = fakeDriver([drained]);
    await drainPendingClaims(driver, { ...options, timeoutMs: 4_000 });
    expect(calls.samples).toBe(3);
  });

  it('one fresh drained read is not enough at the deadline', async () => {
    const { driver } = fakeDriver([drained, drained, claiming]);
    await expect(drainPendingClaims(driver, { ...options, timeoutMs: 4_000 })).rejects.toThrow(
      'last sample: {"onPending":true,"rows":1,"acceptAll":"busy","loading":false}'
    );
  });

  it('judges the list even when the budget is shorter than one lap', async () => {
    const passes = fakeDriver([drained]);
    await drainPendingClaims(passes.driver, { ...options, timeoutMs: 0 });
    expect(passes.calls.samples).toBe(2);

    const fails = fakeDriver([claiming]);
    await expect(drainPendingClaims(fails.driver, { ...options, timeoutMs: 0 })).rejects.toThrow('after 0 lap(s)');
  });

  it('keeps draining when the diagnostics hook throws', async () => {
    const { driver, calls } = fakeDriver([claiming, drained, drained], true, {
      onLapThrow: new Error('onLap crashed')
    });
    await drainPendingClaims(driver, options);
    expect(calls.samples).toBe(3);
  });

  it('treats a click that throws as no click', async () => {
    const { driver } = fakeDriver([waiting, drained, drained], true, { clickThrow: new Error('click failed') });
    const logs: string[] = [];
    driver.log = (line: string) => logs.push(line);
    await drainPendingClaims(driver, options);
    expect(logs.some(line => line.includes('clickAcceptAll failed'))).toBe(true);
    expect(logs.some(line => line.includes('clicked Accept All'))).toBe(false);
  });

  it('keeps draining when reopening the list throws', async () => {
    const { driver, calls } = fakeDriver([elsewhere, drained, drained], true, {
      openThrow: new Error('open failed')
    });
    await drainPendingClaims(driver, options);
    expect(calls.samples).toBe(3);
  });

  it('logs why a read failed', async () => {
    const { driver } = fakeDriver([drained, new Error('cdp eval failed'), drained, drained]);
    const logs: string[] = [];
    driver.log = (line: string) => logs.push(line);
    await drainPendingClaims(driver, options);
    expect(logs.some(line => line.includes('sample failed: cdp eval failed'))).toBe(true);
  });

  it('names the last failed step when the drain times out', async () => {
    const { driver } = fakeDriver([new Error('session closed')]);
    await expect(drainPendingClaims(driver, { ...options, timeoutMs: 4_000 })).rejects.toThrow(
      'last sample: null; Accept All clicked 0 time(s); last failure: sample: session closed'
    );
  });

  it('counts the clicks that landed', async () => {
    const { driver } = fakeDriver([waiting]);
    await expect(drainPendingClaims(driver, { ...options, timeoutMs: 4_000 })).rejects.toThrow(
      'Accept All clicked 1 time(s)'
    );
  });

  it('says nothing about failures when no step failed', async () => {
    const { driver } = fakeDriver([claiming]);
    const promise = drainPendingClaims(driver, { ...options, timeoutMs: 4_000 });
    await expect(promise).rejects.toThrow('did not drain');
    const error = await promise.catch((error: unknown) => error);
    expect(String(error)).not.toContain('last failure');
  });

  it('does not count a click that did not land', async () => {
    const { driver } = fakeDriver([waiting], false);
    await expect(drainPendingClaims(driver, { ...options, timeoutMs: 4_000 })).rejects.toThrow('clicked 0 time(s)');
  });
});

describe('clickFirstAcceptAll', () => {
  const options = { firstClickMs: 2_000, label: 'TestPage.claimAllNotes' };

  it('clicks as soon as Accept All is idle', async () => {
    const { driver, calls } = fakeDriver([claiming]);
    await clickFirstAcceptAll(driver, options);
    expect(calls.clicks).toBe(1);
    expect(calls.samples).toBe(0);
  });

  it('keeps polling until a click lands', async () => {
    const { driver, calls } = fakeDriver([claiming], [false, false, true]);
    await clickFirstAcceptAll(driver, options);
    expect(calls.clicks).toBe(3);
  });

  it('fails with the list when Accept All never becomes clickable', async () => {
    const { driver } = fakeDriver([claiming], false);
    await expect(clickFirstAcceptAll(driver, options)).rejects.toThrow(
      'TestPage.claimAllNotes: Accept All never became clickable within 2000ms; ' +
        'last sample: {"onPending":true,"rows":1,"acceptAll":"busy","loading":false}'
    );
  });
});

describe('claimFromPendingList', () => {
  const options = { label: 'TestPage.claimAllNotes', firstClickMs: 2_000, timeoutMs: 10_000 };

  /** A page whose Pending list reads `reads` in order (the last repeats) and whose Accept All takes a click when `clickLands`. */
  function fakePage(reads: PendingSample | PendingSample[], clickLands: boolean, homeError?: Error) {
    const list = Array.isArray(reads) ? reads : [reads];
    let next = 0;
    const navigateTo = jest.fn(async (_hash: string) => undefined);
    const navigateHome = jest.fn(async () => {
      if (homeError) throw homeError;
    });
    const page: MobileClaimPage = {
      evalJs: async js => {
        if (js === buildClickAcceptAllScript()) return clickLands;
        if (js === buildPendingSampleScript()) return list[Math.min(next++, list.length - 1)];
        return [];
      },
      navigateTo,
      navigateHome,
      triggerSync: async () => undefined
    };
    return { page, navigateTo, navigateHome };
  }

  /** Runs the claim to its end on fake timers; resolves with what it rejected with, if anything. */
  async function settle(claim: Promise<void>): Promise<unknown> {
    const outcome = claim.then(
      () => undefined,
      (error: unknown) => error
    );
    await jest.runAllTimersAsync();
    return outcome;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('goes home whether the claim passes or fails', async () => {
    const passes = fakePage(drained, true);
    expect(await settle(claimFromPendingList(passes.page, options))).toBeUndefined();
    expect(passes.navigateHome).toHaveBeenCalledTimes(1);

    const fails = fakePage(claiming, false);
    expect(String(await settle(claimFromPendingList(fails.page, options)))).toContain(
      'TestPage.claimAllNotes: Accept All never became clickable within 2000ms'
    );
    expect(fails.navigateHome).toHaveBeenCalledTimes(1);
  });

  it('reopens the Pending list at its route when the wallet left it', async () => {
    const { page, navigateTo } = fakePage([elsewhere, drained], true);
    expect(await settle(claimFromPendingList(page, options))).toBeUndefined();
    expect(navigateTo).toHaveBeenCalledWith(ACTIVITY_PENDING_PATH);
  });

  it('a failed claim keeps its own error when going home fails', async () => {
    const sessionClosed = new Error('session closed');

    const neverClickable = fakePage(claiming, false, sessionClosed);
    expect(String(await settle(claimFromPendingList(neverClickable.page, options)))).toContain(
      'Accept All never became clickable'
    );

    const neverDrains = fakePage(claiming, true, sessionClosed);
    expect(String(await settle(claimFromPendingList(neverDrains.page, options)))).toContain('did not drain');
  });

  it('a claim that passed still reports a failed trip home', async () => {
    const { page } = fakePage(drained, true, new Error('session closed'));
    expect(String(await settle(claimFromPendingList(page, options)))).toContain('session closed');
  });
});
