import React, { FC, memo, ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useReducedMotion } from 'framer-motion';

import CommandLauncher from 'app/layouts/CommandLauncher';
import { PageActiveContext, usePageActive, useTabShownAgain } from 'app/layouts/page-active';
import Earn from 'app/pages/Earn';
import Explore from 'app/pages/Explore';
import { Receive } from 'app/pages/Receive';
import { cancelSpring, pagerMotion, playKeyframes } from 'lib/animation';
import { isSwapEnabled } from 'lib/feature-flags';
import { boostRefreshRate } from 'lib/mobile/high-refresh-rate';
import { beginInteraction } from 'lib/ui/interaction-priority';
import { useLocation } from 'lib/woozie';
import { SendFlow } from 'screens/send-flow/SendManager';
import { SwapFlow } from 'screens/swap-flow/SwapManager';

/**
 * The home-group pages (Overview / Send / Receive / Earn / Swap), stacked in one place and all kept
 * mounted, so each keeps its state and scroll. They are separate destinations, not one strip, so
 * nothing pages on a swipe (#2415): the top tabs (or a route change from anywhere else) choose the
 * page, and a change fades the old one out and the new one in, nudged from its tab's side.
 *
 * Pathname is the source of truth for which page is shown. Only Swap (isSwapEnabled) is
 * feature-gated.
 */

interface HomePage {
  id: string;
  path: string;
  node: ReactNode;
}

function buildPages(swapEnabled: boolean): HomePage[] {
  return [
    { id: 'overview', path: '/', node: <Explore balanceAction={<CommandLauncher />} /> },
    { id: 'send', path: '/send', node: <SendFlow isLoading={false} /> },
    { id: 'receive', path: '/receive', node: <Receive /> },
    { id: 'earn', path: '/earn', node: <Earn /> },
    ...(swapEnabled ? [{ id: 'swap', path: '/swap', node: <SwapFlow /> }] : [])
  ];
}

const tx = (px: number) => (px ? `translateX(${px}px)` : 'none');

interface Drawn {
  opacity: number;
  x: number;
}

/** Where a running switch has a pane on screen. Forces a style flush, so only on a discrete event. */
function readDrawn(el: HTMLElement): Drawn {
  const style = getComputedStyle(el);
  const opacity = style.opacity === '' ? 1 : Number(style.opacity);
  const { transform } = style;
  const x = !transform || transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
  return { opacity, x };
}

// Never `visible`: the Home tab hides its whole pane through an ancestor, and a pane forced visible
// would show through every other tab. Shown means inheriting.
const show = (el: HTMLElement) => el.style.removeProperty('visibility');

function hide(el: HTMLElement) {
  cancelSpring(el);
  el.style.visibility = 'hidden';
  for (const property of ['opacity', 'transform', 'pointer-events']) el.style.removeProperty(property);
}

interface PaneProps {
  id: string;
  active: boolean;
  inert: boolean;
  node: ReactNode;
}

/** One page of the stack. Memoized so a route change re-renders only the panes whose flags changed. */
const Pane = memo(function Pane({ id, active, inert, node }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop. Every pane but the route's is inert from the commit that leaves it,
  // so focus, find-in-page and assistive tech never reach a page that is going or gone.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [inert]);
  return (
    <div ref={ref} data-home-page={id} className="absolute inset-0">
      <PageActiveContext.Provider value={active}>{node}</PageActiveContext.Provider>
    </div>
  );
});

const HomePanes: FC = () => {
  const { pathname } = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const swapEnabled = isSwapEnabled();
  const pages = useMemo(() => buildPages(swapEnabled), [swapEnabled]);

  // The home page the route names, or -1 when it names none.
  const routeIdx = (() => {
    const exact = pages.findIndex(p => p.path === pathname);
    if (exact !== -1) return exact;
    // Match by prefix for nested routes (e.g. /send/sub-step).
    return pages.findIndex(p => p.path !== '/' && pathname.startsWith(`${p.path}/`));
  })();
  // TabLayout keeps this pane mounted, hidden, while another tab shows, and the route then names no
  // home page. The stack holds the page it was on rather than switching to Overview out of sight.
  const onHome = routeIdx !== -1;
  const selectedPageId = pages[routeIdx]?.id;
  const lastHomeIdxRef = useRef(0);
  const shownAgain = useTabShownAgain();
  const activeIdx = onHome ? routeIdx : lastHomeIdxRef.current;
  // Every page stays mounted, so only the selected one, on a shown and uncovered tab, is on screen;
  // the others pause their display-only work as a hidden tab's pages do.
  const parentActive = usePageActive();

  // The pane last placed or switched to, and the pages it was placed among.
  const targetRef = useRef<{ index: number; pages: HomePage[] } | null>(null);
  // The switch in flight; an older switch's callbacks compare against it and do nothing.
  const runningRef = useRef<{ target: number } | null>(null);
  const holdRef = useRef<{ end: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);

  // Every page stays mounted, so a page can keep its focused input after it is switched away. Release
  // that focus when the route selects another page so the mobile keyboard closes and its navbar hold
  // can end.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const focusedPage = focused.closest('[data-home-page]');
    if (!focusedPage || focusedPage.getAttribute('data-home-page') === selectedPageId) return;
    focused.blur();
  }, [selectedPageId]);

  // Runs after the panes' own layout effects, so the leaving pane is already inert.
  useLayoutEffect(() => {
    if (onHome) lastHomeIdxRef.current = activeIdx;
    const root = rootRef.current;
    if (!root) return;
    const panes = Array.from(root.children) as HTMLElement[];
    const placed = targetRef.current;
    if (placed && placed.pages === pages && placed.index === activeIdx) return;
    targetRef.current = { index: activeIdx, pages };

    const place = (target: number) => {
      runningRef.current = null;
      panes.forEach((el, i) => {
        hide(el);
        if (i === target) show(el);
      });
    };

    // The first placement and a new pages list place the page; a tab shown again swaps, which is
    // what a tab change does. `shownAgain` and `reduceMotion` are read, not triggers: the commit that
    // shows the pane again also raises `onHome`, which runs this effect.
    if (!placed || placed.pages !== pages || shownAgain || reduceMotion || typeof root.animate !== 'function') {
      place(activeIdx);
      return;
    }

    const was = runningRef.current;
    // At rest the shown pane is fully drawn and the others hidden; only a running switch is read.
    const drawn = panes.map(el =>
      el.style.visibility === 'hidden' ? null : was ? readDrawn(el) : { opacity: 1, x: 0 }
    );
    let lead = -1;
    drawn.forEach((d, i) => {
      if (!d) return;
      const best = lead === -1 ? -1 : (drawn[lead] as Drawn).opacity;
      if (d.opacity > best || (d.opacity === best && i === was?.target)) lead = i;
    });
    const target = activeIdx;
    const from = drawn[target] ?? { opacity: 0, x: 0 };
    if (lead === -1 || (lead === target && from.opacity >= 0.99)) {
      place(target);
      return;
    }

    const sw = { target };
    runningRef.current = sw;
    const previous = holdRef.current;
    const end = beginInteraction();
    holdRef.current = {
      end,
      timer: setTimeout(() => {
        end();
        if (holdRef.current?.end === end) holdRef.current = null;
      }, pagerMotion.switchHoldMs)
    };
    // The new hold begins before the old one ends, so background work never slips in between.
    if (previous) {
      clearTimeout(previous.timer);
      previous.end();
    }
    boostRefreshRate(pagerMotion.switchHoldMs);

    panes.forEach((el, i) => {
      const d = drawn[i];
      if (i === target || !d) return;
      if (d.opacity <= 0.01) {
        hide(el);
        return;
      }
      const exit = playKeyframes(
        el,
        [
          { opacity: d.opacity, transform: tx(d.x) },
          { opacity: 0, transform: tx(d.x) }
        ],
        pagerMotion.switchExitMs * d.opacity,
        { opacity: '0', transform: tx(d.x) }
      );
      // A newer switch cancels this one, which never finishes, so it never hides a pane coming back.
      if (exit) exit.onfinish = () => hide(el);
      else hide(el);
    });

    const el = panes[target];
    if (!el) return;
    show(el);
    // UIKit's rule during a transition: no tap lands on a page that is not there yet or still moving.
    el.style.pointerEvents = 'none';
    let keyframes: Keyframe[];
    let duration: number;
    if (lead === target) {
      // Still the most visible pane: rise from where it is drawn.
      duration = pagerMotion.switchEnterMs * (1 - from.opacity);
      keyframes = [
        { opacity: from.opacity, transform: tx(from.x), easing: pagerMotion.switchEnterEasing },
        { opacity: 1, transform: 'none' }
      ];
    } else {
      // Wait out the lead's exit, then enter from the tab's side. The wait is a held keyframe, not a
      // delay: the animation fills nothing, so a delay would paint the pane at rest until it began.
      const hold = pagerMotion.switchExitMs * (drawn[lead] as Drawn).opacity;
      const nudge = tx(Math.sign(target - lead) * pagerMotion.switchNudgePx);
      duration = hold + pagerMotion.switchEnterMs;
      keyframes = [
        { opacity: 0, transform: nudge },
        { opacity: 0, transform: nudge, offset: hold / duration, easing: pagerMotion.switchEnterEasing },
        { opacity: 1, transform: 'none' }
      ];
    }
    const done = () => {
      if (runningRef.current !== sw) return;
      runningRef.current = null;
      el.style.removeProperty('pointer-events');
    };
    const enter = playKeyframes(el, keyframes, duration, { opacity: null, transform: null });
    if (enter) {
      enter.onfinish = done;
      enter.oncancel = done;
    } else done();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownAgain and reduceMotion are read, not triggers (above)
  }, [activeIdx, onHome, pages]);

  useEffect(() => {
    // Captured now: the ref is already detached when an unmount's cleanup runs.
    const root = rootRef.current;
    return () => {
      runningRef.current = null;
      if (root) for (const el of Array.from(root.children)) cancelSpring(el);
      const hold = holdRef.current;
      holdRef.current = null;
      if (hold) {
        clearTimeout(hold.timer);
        hold.end();
      }
    };
  }, []);

  return (
    <div ref={rootRef} data-home-panes className="relative h-full w-full bg-app-bg">
      {pages.map((page, index) => (
        <Pane
          key={page.id}
          id={page.id}
          active={parentActive && index === activeIdx}
          inert={index !== activeIdx}
          node={page.node}
        />
      ))}
    </div>
  );
};

export default HomePanes;
