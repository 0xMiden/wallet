import {
  buildClickAcceptAllScript,
  buildPendingSampleScript,
  drainPendingClaims,
  isDrained,
  type DrainDriver,
  type PendingSample
} from './claim-drain';

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

describe('drainPendingClaims', () => {
  const drained: PendingSample = { onPending: true, rows: 0, acceptAll: 'absent', loading: false };
  const claiming: PendingSample = { onPending: true, rows: 1, acceptAll: 'busy', loading: false };
  const waiting: PendingSample = { onPending: true, rows: 1, acceptAll: 'idle', loading: false };
  const loadingEmpty: PendingSample = { onPending: true, rows: 0, acceptAll: 'absent', loading: true };
  const elsewhere: PendingSample = { onPending: false, rows: 0, acceptAll: 'absent', loading: false };
  const options = { timeoutMs: 120_000, label: 'TestPage.claimAllNotes' };

  /** A driver over a scripted run of reads (the last one repeats) and a clock only sync and sleep move. */
  function fakeDriver(reads: Array<PendingSample | Error>, clickLands = true) {
    let now = 0;
    let next = 0;
    const calls = { samples: 0, clicks: 0, reopens: 0 };
    const driver: DrainDriver = {
      sample: async (): Promise<PendingSample> => {
        calls.samples++;
        const read = reads[Math.min(next++, reads.length - 1)];
        if (read instanceof Error) throw read;
        return read as PendingSample;
      },
      clickAcceptAll: async () => {
        calls.clicks++;
        return clickLands;
      },
      openPending: async () => {
        calls.reopens++;
      },
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
});
