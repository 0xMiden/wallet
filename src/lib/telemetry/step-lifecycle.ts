import type { StepProgressionTracker } from './step-progression';

/** Returns true when the current document is hidden and inactive for foreground dwell. */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export interface VisibleDwellTimer {
  consume(): number;
  cancel(): void;
}

/**
 * Passively tracks foreground dwell without holding a flowId or emitting events.
 * Used between a failed submission and an eventual retry so review dwell before
 * retry can still be carried onto the fresh retry flowId.
 */
export function startVisibleDwellTimer(now?: () => number): VisibleDwellTimer {
  const clock = now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const doc = typeof document !== 'undefined' ? document : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;

  let isVisible = !isDocumentHidden();
  let accumulatedMs = 0;
  let visibleSince: number | null = isVisible ? clock() : null;
  let stopped = false;

  const flush = (at: number) => {
    if (isVisible && visibleSince !== null) {
      accumulatedMs += Math.max(0, at - visibleSince);
      visibleSince = at;
    }
  };

  const setVisible = (nextVisible: boolean) => {
    if (stopped || nextVisible === isVisible) return;
    const at = clock();
    if (nextVisible) {
      isVisible = true;
      visibleSince = at;
      return;
    }
    flush(at);
    isVisible = false;
    visibleSince = null;
  };

  const onVisibilityChange = () => {
    setVisible(!isDocumentHidden());
  };
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      setVisible(false);
      return;
    }
    cancel();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      setVisible(!isDocumentHidden());
    }
  };

  const detach = () => {
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('pageshow', onPageShow);
  };

  const cancel = () => {
    if (stopped) return;
    stopped = true;
    accumulatedMs = 0;
    visibleSince = null;
    detach();
  };

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('pageshow', onPageShow);

  return {
    consume(): number {
      if (stopped) return 0;
      flush(clock());
      stopped = true;
      visibleSince = null;
      const elapsed = Math.max(0, Math.round(accumulatedMs));
      accumulatedMs = 0;
      detach();
      return elapsed;
    },
    cancel
  };
}

/**
 * Binds foreground visibility pause/resume and abrupt `pagehide` teardown to a
 * progression tracker, preserving BFCache (`persisted: true`) suspensions as pauses
 * and returning an idempotent cleanup function.
 */
export function attachStepProgressionLifecycle(tracker: StepProgressionTracker): () => void {
  const doc = typeof document !== 'undefined' ? document : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;

  const onVisibilityChange = () => {
    tracker.visible(!isDocumentHidden());
  };
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      tracker.visible(false);
      return;
    }
    tracker.teardown();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      tracker.visible(!isDocumentHidden());
    }
  };

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('pageshow', onPageShow);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('pageshow', onPageShow);
  };
}
