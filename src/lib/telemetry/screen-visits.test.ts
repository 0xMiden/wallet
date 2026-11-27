import { createVisitTracker, screenForPath } from './screen-visits';
import { ScreenVisitEvent } from './types';

function setup() {
  let t = 1000;
  const events: ScreenVisitEvent[] = [];
  const tracker = createVisitTracker({
    now: () => t,
    surface: 'popup',
    runId: () => 'run-1',
    emit: e => events.push(e)
  });
  return { tracker, events, advance: (ms: number) => (t += ms) };
}

describe('screenForPath', () => {
  it.each([
    ['/', 'overview'],
    ['/send', 'send'],
    ['/send/review', 'send'],
    ['/receive', 'receive'],
    ['/swap', 'swap'],
    ['/earn/vaults/abc/deposit', 'earn'],
    ['/me', 'me'],
    ['/me/badges', 'me'],
    ['/browser', 'explore'],
    ['/arcade/coins', 'explore'],
    ['/history', 'activity'],
    ['/history/some-program', 'activity'],
    ['/history-details/tx-1', 'activity'],
    ['/activity/group/swap', 'activity'],
    ['/activity/group/counterparty/0xdeadbeef', 'activity'],
    ['/bridge/deposit', 'funding'],
    ['/generating-transaction/0xabc', 'tx_status'],
    ['/settings/general', 'other'],
    ['/contacts/0xdeadbeef', 'other'],
    ['/token-detail/mid1abc', 'other']
  ])('%s is %s', (path, screen) => {
    expect(screenForPath(path)).toBe(screen);
  });
});

describe('createVisitTracker', () => {
  it('numbers visits from 1 again when the run id rotates', () => {
    let run = 'run-1';
    let t = 0;
    const events: ScreenVisitEvent[] = [];
    const tracker = createVisitTracker({ now: () => t, surface: 'popup', runId: () => run, emit: e => events.push(e) });
    tracker.route('overview', 'initial');
    t += 1000;
    tracker.route('send', 'push');
    t += 1000;
    run = 'run-2';
    tracker.route('swap', 'push');
    t += 1000;
    tracker.teardown();
    expect(events.map(e => [e.runId, e.order])).toEqual([
      ['run-1', 1],
      ['run-2', 1],
      ['run-2', 2]
    ]);
  });

  it('reports a visit ended by hiding as complete even when the page is torn down afterwards', () => {
    const { tracker, events, advance } = setup();
    tracker.route('send', 'initial');
    advance(900);
    tracker.visible(false);
    tracker.teardown();
    expect(events.map(e => [e.visibleMs, e.complete])).toEqual([[900, true]]);
  });

  it('reports a visit with its visible time when the screen changes', () => {
    const { tracker, events, advance } = setup();
    tracker.route('overview', 'initial');
    advance(2000);
    tracker.route('send', 'push');
    expect(events).toEqual([
      {
        phase: 'visit',
        screen: 'overview',
        source: 'initial',
        surface: 'popup',
        order: 1,
        visibleMs: 2000,
        complete: true,
        runId: 'run-1'
      }
    ]);
  });

  it('drops a pass-through shorter than the dwell, so a swipe across panes does not inflate visits', () => {
    const { tracker, events, advance } = setup();
    tracker.route('overview', 'initial');
    advance(3000);
    tracker.route('send', 'push');
    advance(200);
    tracker.route('receive', 'push');
    advance(200);
    tracker.route('swap', 'push');
    advance(2000);
    tracker.route('overview', 'back');
    expect(events.map(e => e.screen)).toEqual(['overview', 'swap']);
    expect(events.map(e => e.order)).toEqual([1, 2]);
  });

  it('does not count time while the page is hidden, and a return is a new visit', () => {
    const { tracker, events, advance } = setup();
    tracker.route('earn', 'initial');
    advance(1000);
    tracker.visible(false);
    advance(60_000);
    tracker.visible(true);
    advance(1500);
    tracker.route('me', 'push');
    expect(events.map(e => [e.screen, e.source, e.visibleMs])).toEqual([
      ['earn', 'initial', 1000],
      ['earn', 'resume', 1500]
    ]);
  });

  it('counts a revisit as a new visit', () => {
    const { tracker, events, advance } = setup();
    tracker.route('overview', 'initial');
    advance(1000);
    tracker.route('activity', 'push');
    advance(1000);
    tracker.route('overview', 'back');
    advance(1000);
    tracker.route('me', 'push');
    expect(events.map(e => e.screen)).toEqual(['overview', 'activity', 'overview']);
  });

  it('reports nothing while hidden at route change and nothing while the wallet is unusable', () => {
    const { tracker, events, advance } = setup();
    tracker.route(null, 'initial');
    advance(5000);
    tracker.visible(false);
    tracker.route('overview', 'initial');
    advance(5000);
    tracker.route('send', 'push');
    expect(events).toEqual([]);
  });

  it('reports a torn-down visit as incomplete', () => {
    const { tracker, events, advance } = setup();
    tracker.route('send', 'initial');
    advance(900);
    tracker.teardown();
    expect(events).toHaveLength(1);
    expect(events[0]?.complete).toBe(false);
  });

  it('reports nothing after teardown even if the page is shown again', () => {
    const { tracker, events, advance } = setup();
    tracker.route('send', 'initial');
    tracker.teardown();
    tracker.visible(false);
    tracker.visible(true);
    advance(5000);
    tracker.teardown();
    expect(events).toEqual([]);
  });
});
