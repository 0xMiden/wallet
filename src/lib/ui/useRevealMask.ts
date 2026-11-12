import { useCallback, useEffect, useState } from 'react';

/**
 * Show/hide state for a secret. With `remaskOnLeave` it hides again whenever the window loses focus,
 * is hidden or is torn down, so a revealed secret never outlives the user looking at it.
 */
export function useRevealMask({ remaskOnLeave }: { remaskOnLeave: boolean }): {
  revealed: boolean;
  toggle: () => void;
} {
  const [revealed, setRevealed] = useState(false);
  const toggle = useCallback(() => setRevealed(current => !current), []);

  useEffect(() => {
    if (!remaskOnLeave) return;
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
  }, [remaskOnLeave]);

  return { revealed, toggle };
}
