import { useEffect, useRef } from 'react';

import { useAppEnv } from 'app/env';
import { request } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { touchRun } from 'lib/telemetry/run';
import { createVisitTracker, screenForPath, VisitTracker } from 'lib/telemetry/screen-visits';
import { ScreenVisitEvent, TelemetryNavSource, TelemetrySurface } from 'lib/telemetry/types';
import { HistoryAction } from 'lib/woozie';

const SOURCE_OF: Record<string, TelemetryNavSource> = {
  [HistoryAction.Push]: 'push',
  [HistoryAction.Pop]: 'back',
  [HistoryAction.Replace]: 'replace'
};

function report(event: ScreenVisitEvent): void {
  void (async () => {
    try {
      await request({ type: WalletMessageType.ReportTelemetryEventRequest, event });
    } catch {
      // Telemetry must never surface as a user-visible failure.
    }
  })();
}

/**
 * Report which screen the usable wallet shows and for how long it is visible. `usable` is false on the lock screen
 * and during onboarding, so those report nothing, and a wallet that unlocks later starts again at `initial`.
 * Sharing is gated in the background, as for every other event.
 */
export function useScreenVisitTelemetry(usable: boolean, pathname: string, trigger: HistoryAction | null): void {
  const { popup, sidePanel } = useAppEnv();
  const surface: TelemetrySurface = isMobile() ? 'app' : popup ? 'popup' : sidePanel ? 'side_panel' : 'full_page';
  const trackerRef = useRef<VisitTracker | null>(null);
  const wasUsable = useRef(false);

  useEffect(() => {
    const tracker = createVisitTracker({ now: () => performance.now(), surface, runId: touchRun, emit: report });
    trackerRef.current = tracker;
    wasUsable.current = false;
    tracker.visible(document.visibilityState !== 'hidden');
    const onVisibility = () => tracker.visible(document.visibilityState !== 'hidden');
    // A persisted pagehide is a page-cache suspension that can be restored, so it only hides; anything else is final.
    const onHide = (e: PageTransitionEvent) => (e.persisted ? tracker.visible(false) : tracker.teardown());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      tracker.teardown();
      trackerRef.current = null;
    };
  }, [surface]);

  useEffect(() => {
    const source = wasUsable.current ? (trigger && SOURCE_OF[trigger]) || 'push' : 'initial';
    trackerRef.current?.route(usable ? screenForPath(pathname) : null, source);
    wasUsable.current = usable;
  }, [usable, pathname, trigger]);
}
