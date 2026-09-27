import { buildClickAcceptAllScript, buildPendingSampleScript, isDrained, type PendingSample } from './claim-drain';

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
