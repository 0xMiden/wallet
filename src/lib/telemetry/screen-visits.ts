import { ScreenVisitEvent, TelemetryNavSource, TelemetryScreen, TelemetrySurface } from './types';
import { ROUTE_DWELL_MS } from './use-route-dwell';

/**
 * Map a route to the closed screen it shows. By pathname, never by what is mounted: Home keeps retained tabs and
 * panes mounted beside the visible one, so only the route says what the person is looking at. Nothing from the path
 * (ids, addresses, query) survives the mapping; anything unlisted is `other`.
 */
export function screenForPath(pathname: string): TelemetryScreen {
  const first = pathname.split('/')[1] ?? '';
  switch (first) {
    case '':
      return 'overview';
    case 'send':
    case 'receive':
    case 'swap':
    case 'earn':
    case 'me':
      return first;
    case 'bridge':
      return pathname === '/bridge/deposit' ? 'funding' : 'other';
    case 'browser':
    case 'arcade':
      return 'explore';
    case 'history':
    case 'history-details':
    case 'activity':
      return 'activity';
    case 'generating-transaction':
    case 'generating-transaction-full':
      return 'tx_status';
    default:
      return 'other';
  }
}

export interface VisitTracker {
  /** The screen now shown, or null when the wallet is not usable (locked, onboarding). */
  route(screen: TelemetryScreen | null, source: TelemetryNavSource): void;
  /** Whether the document is visible. Time is counted only while it is. */
  visible(isVisible: boolean): void;
  /** The page is going away: report the open visit as incomplete. */
  teardown(): void;
}

interface Deps {
  now: () => number;
  surface: TelemetrySurface;
  runId: () => string;
  emit: (event: ScreenVisitEvent) => void;
}

/**
 * Turns route and visibility changes into one event per visit.
 *
 * A visit is a stretch on one screen while the document is visible, so hiding the page ends it and showing it again
 * starts a new one (`resume`). Stretches shorter than the Home page dwell are dropped, as `useRouteDwell` does for
 * flows, so passing through panes does not inflate visits. Everything lives in memory.
 */
export function createVisitTracker({ now, surface, runId, emit }: Deps): VisitTracker {
  let screen: TelemetryScreen | null = null;
  let source: TelemetryNavSource = 'initial';
  let isVisible = true;
  let since: number | null = null;
  let order = 0;
  let orderRun: string | null = null;

  const open = () => {
    if (screen !== null && isVisible && since === null) since = now();
  };

  const close = (complete: boolean) => {
    if (screen === null || since === null) return;
    const visibleMs = now() - since;
    since = null;
    if (visibleMs < ROUTE_DWELL_MS) return;
    const run = runId();
    // `order` is per run: a rotated run starts again at 1 rather than carrying the old run's count.
    order = run === orderRun ? order + 1 : 1;
    orderRun = run;
    emit({ phase: 'visit', screen, source, surface, order, visibleMs, complete, runId: run });
  };

  return {
    route(next, nextSource) {
      if (next === screen) return;
      close(true);
      screen = next;
      source = nextSource;
      open();
    },
    visible(next) {
      if (next === isVisible) return;
      close(true);
      isVisible = next;
      source = 'resume';
      open();
    },
    teardown() {
      close(false);
      screen = null;
    }
  };
}
