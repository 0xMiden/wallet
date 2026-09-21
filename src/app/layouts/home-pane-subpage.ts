import { useLayoutEffect, useSyncExternalStore } from 'react';

import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';

/**
 * A sub-page pushed inside a home-carousel pane takes over the whole screen.
 *
 * Earn set the standard by accident: its vault detail is a ROUTED page (`/earn/vaults/:id` →
 * `FullScreenPage`), so it renders outside `TabLayout` and neither the top action bar nor the
 * bottom tab bar is in its tree — just its own `PageHeader` and its pinned CTA. A step pushed
 * inside a pane (Send's amount step, Swap's review) is a `Navigator` card INSIDE the pane, so the
 * pane — and the action bar above it — stayed mounted around it and squeezed the step into what
 * was left. Same kind of screen, two different frames.
 *
 * This is the one place that says which of the two a screen is, for every pane. A flow raises it
 * while one of its own steps is pushed; `TabLayout` reads it and drops the action bar (and the
 * status-bar band that continues it) for as long as it is up.
 *
 * Raising it also raises the shared `data-hide-navbar` flag, so everything already keyed off that
 * flag follows without a second rule: the bottom nav fades out, `FlowFooter`'s cushion over it
 * collapses, the carousel's horizontal drag is locked (`useNavbarHidden`, #481) and iOS repaints
 * the bottom safe-area strip. A sub-page is one more surface that owns the screen, which is what
 * that flag has always meant.
 *
 * **Gate the caller on the pathname.** `TabLayout` keeps every visited pane mounted, so a flow
 * left mid-step stays mounted while another pane — or another tab — is on screen; ungated, a send
 * flow parked on its amount step would strip the action bar off Overview too. Every caller reads
 * `pathname === <its own pane's path>`, the same gate `SendManager` has used since #481.
 */

let openCount = 0;
const listeners = new Set<() => void>();

const isOpen = () => openCount > 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Declares that this pane has a sub-page up. Reference counted, like the navbar flag it raises:
 * a pane handing over to another (a step pushed as the previous one unmounts) never blinks the
 * chrome back on in between.
 */
export function useHomePaneSubPage(open: boolean): void {
  useHideNavbarWhileOpen(open);

  // A layout effect, so the count is published in the same commit the step mounts in and the bar
  // is gone before that frame paints — the step must never be drawn once with the bar above it.
  useLayoutEffect(() => {
    if (!open) return;
    openCount += 1;
    listeners.forEach(listener => listener());
    return () => {
      openCount = Math.max(0, openCount - 1);
      listeners.forEach(listener => listener());
    };
  }, [open]);
}

/** Whether any pane currently has a sub-page up. Read by `TabLayout` to hide the action bar. */
export function useHomePaneSubPageOpen(): boolean {
  return useSyncExternalStore(subscribe, isOpen, isOpen);
}
