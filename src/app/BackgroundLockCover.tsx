import React, { FC, useLayoutEffect } from 'react';

import { createPortal } from 'react-dom';

import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import { backgroundLockPending } from 'lib/lock-up/background-lock';
import { useMidenContext } from 'lib/miden/front';

const COVER_ID = 'background-lock-cover';

/**
 * Hides and disables everything while a background lock lands, including the sheets, dialogs and prompts that sit
 * beside the page router and portal to `body`. Sits above the highest z-index in the app (`z-[9999]`). Providers stay
 * mounted; only what is beneath is made inert.
 */
export const BackgroundLockCover: FC = () => {
  const pending = backgroundLockPending.useValue();
  const { ready } = useMidenContext();
  const covered = pending && ready;

  // Layout effect: a modal that is already open is inert in the same frame the cover appears.
  useLayoutEffect(() => {
    if (!covered) return undefined;
    const inerted: Element[] = [];
    // Never un-inert what was inert before the cover rose.
    const makeInert = (el: Element) => {
      if (el.id === COVER_ID || el.hasAttribute('inert')) return;
      el.setAttribute('inert', '');
      inerted.push(el);
    };
    Array.from(document.body.children).forEach(makeInert);
    // A sheet that opens while the lock is still landing (the WASM lock can be held for a long sync) must not be usable.
    const observer = new MutationObserver(records =>
      records.forEach(record => record.addedNodes.forEach(node => node instanceof Element && makeInert(node)))
    );
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      inerted.forEach(el => el.removeAttribute('inert'));
    };
  }, [covered]);

  if (!covered) return null;
  return createPortal(
    <div id={COVER_ID} className="pointer-events-auto fixed inset-0 z-[10000] bg-app-bg">
      <RootSuspenseFallback data-testid="wallet-locking" />
    </div>,
    document.body
  );
};
