import type { StepProgressionTracker } from './step-progression';

/** Returns true when the current document is hidden and inactive for foreground dwell. */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Binds foreground visibility pause/resume and abrupt `pagehide` teardown to a
 * progression tracker, returning an idempotent cleanup function.
 */
export function attachStepProgressionLifecycle(tracker: StepProgressionTracker): () => void {
  const doc = typeof document !== 'undefined' ? document : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;

  const onVisibilityChange = () => {
    tracker.visible(!isDocumentHidden());
  };
  const onPageHide = () => {
    tracker.teardown();
  };

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  win?.addEventListener('pagehide', onPageHide);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('pagehide', onPageHide);
  };
}
