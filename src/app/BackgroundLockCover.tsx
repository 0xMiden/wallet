import React, { FC, useEffect } from 'react';

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

  useEffect(() => {
    if (!covered) return undefined;
    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el.id === COVER_ID || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      inerted.push(el);
    }
    return () => inerted.forEach(el => el.removeAttribute('inert'));
  }, [covered]);

  if (!covered) return null;
  return createPortal(
    <div id={COVER_ID} className="fixed inset-0 z-[10000] bg-app-bg">
      <RootSuspenseFallback data-testid="wallet-locking" />
    </div>,
    document.body
  );
};
