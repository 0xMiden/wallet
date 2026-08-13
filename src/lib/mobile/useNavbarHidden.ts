import { useEffect, useState } from 'react';

/**
 * Reactively read the `data-hide-navbar` body flag that
 * `useHideNavbarWhileOpen` sets whenever a focused sub-surface is up — the
 * keyboard is visible, a drawer/flow is open, or the send flow is past the
 * recipient step. Consumers use it to suppress ambient gestures that would
 * otherwise fight that surface, e.g. the home carousel's horizontal swipe
 * hijacking a nested send sub-step and overlaying two screens (#481).
 */
export function useNavbarHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== 'undefined' && document.body.hasAttribute('data-hide-navbar')
  );

  useEffect(() => {
    const sync = () => setHidden(document.body.hasAttribute('data-hide-navbar'));
    sync(); // catch any change between the initial render and this effect
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-hide-navbar'] });
    return () => observer.disconnect();
  }, []);

  return hidden;
}
