import { useCallback, useEffect, useState } from 'react';

import { isMobile } from 'lib/platform';

/** Off mobile, a revealed secret is masked. Mobile shows the words at once. */
export function revealMaskApplies(): boolean {
  return !isMobile();
}

/**
 * Show/hide state for a secret. While `revealMaskApplies()` it hides again whenever the window loses
 * focus, is hidden or is torn down, so a revealed secret never outlives the user looking at it.
 * `resetKey` hides it whenever it changes, so a page that outlives its secret starts the next one masked.
 * `autoHideMs` also hides it that long after each Show.
 */
export function useRevealMask({ resetKey, autoHideMs }: { resetKey?: string | null; autoHideMs?: number } = {}): {
  revealed: boolean;
  masked: boolean;
  toggle: () => void;
} {
  const [revealed, setRevealed] = useState(false);
  const toggle = useCallback(() => setRevealed(current => !current), []);
  const applies = revealMaskApplies();

  useEffect(() => {
    setRevealed(false);
  }, [resetKey]);

  useEffect(() => {
    if (!applies) return;
    const hide = () => setRevealed(false);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [applies]);

  useEffect(() => {
    if (!applies || !revealed || autoHideMs === undefined) return undefined;
    const timer = setTimeout(() => setRevealed(false), autoHideMs);
    return () => clearTimeout(timer);
  }, [applies, revealed, autoHideMs]);

  return { revealed, masked: revealMaskApplies() && !revealed, toggle };
}
