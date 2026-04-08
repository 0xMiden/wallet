/**
 * Single-row, horizontally-scrollable list of FEATURED dApps.
 *
 * Previously this was a 4-column grid that wrapped to 2 rows when
 * there were more than 4 featured dApps (7 by default). Matching the
 * new `<RecentsRow>` which is always one row, we now render featured
 * dApps as a horizontally-scrolling strip with fixed-width tiles so
 * the section is visually consistent with Recents: one line, scroll
 * horizontally when there are more than fit on screen.
 *
 * Left/right chevron affordances appear only when (a) the content
 * overflows the viewport (more than the visible-count threshold AND
 * scrollWidth > clientWidth) and (b) there's room to scroll in that
 * direction. Tapping a chevron scrolls the strip by roughly one
 * viewport-worth in the chosen direction.
 *
 * Filter chips from `<CategoryRow>` narrow the list to a single category.
 * Each tile is a `<DappTile>` whose `layoutId` matches the `<CapsuleBar>`
 * favicon + name, so opening a dApp morphs the tile into the capsule.
 */

import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { FEATURED_DAPPS, type FeaturedDappCategory } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

import { DappTile } from './DappTile';

// Each tile takes a fixed width so the horizontal strip has a
// predictable rhythm (matching the ~93pt column width of the
// previous 4-col grid on iPhone 17).
const TILE_WIDTH = 93;
// Chevrons only appear when the list exceeds what a single viewport
// of the launcher grid can show (~4 tiles on a 402pt iPhone 17
// viewport). At or below this count the strip fits without overflow
// so scroll indicators would be dead chrome.
const OVERFLOW_THRESHOLD = 4;

interface MyDappsGridProps {
  category: FeaturedDappCategory | null;
  onOpen: (url: string) => void;
}

export const MyDappsGrid: FC<MyDappsGridProps> = ({ category, onOpen }) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const featured = useMemo(
    () => (category ? FEATURED_DAPPS.filter(d => d.category === category) : FEATURED_DAPPS),
    [category]
  );

  // Re-compute whether each chevron should show, based on the scroller's
  // current scrollLeft vs its scrollWidth/clientWidth. Called on mount,
  // on every scroll event, and on ResizeObserver fires (so rotation
  // and viewport changes update the affordances).
  const updateChevronVisibility = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Epsilon for float rounding; sub-pixel fractions shouldn't flip the
    // chevron state.
    const eps = 1;
    const hasOverflow = el.scrollWidth - el.clientWidth > eps;
    if (!hasOverflow) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > eps);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - eps);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateChevronVisibility();
    const onScroll = () => updateChevronVisibility();
    el.addEventListener('scroll', onScroll, { passive: true });
    // Also observe size changes — viewport resize, orientation, etc.
    const ro = new ResizeObserver(updateChevronVisibility);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [updateChevronVisibility, featured.length]);

  const handleChevronClick = useCallback((direction: 'left' | 'right') => {
    const el = scrollerRef.current;
    if (!el) return;
    hapticLight();
    // Scroll by ~80% of the visible width so there's a small overlap
    // with what was previously on screen — keeps the user oriented.
    const delta = Math.round(el.clientWidth * 0.8) * (direction === 'left' ? -1 : 1);
    el.scrollBy({ left: delta, behavior: 'smooth' });
  }, []);

  if (featured.length === 0) {
    return <div className="px-4 py-12 text-center text-sm text-grey-400">{t('noDappsInCategory')}</div>;
  }

  // Only wire up scroll affordances when there are MORE than the
  // overflow threshold AND the browser actually reports overflow
  // (updateChevronVisibility handles the latter).
  const couldOverflow = featured.length > OVERFLOW_THRESHOLD;

  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-grey-500">
        {category ? t(`category${category[0].toUpperCase()}${category.slice(1)}`) : t('myDapps')}
      </h2>
      <div className="relative">
        <div
          ref={scrollerRef}
          className="flex gap-1 overflow-x-auto px-2 pb-1"
          style={{
            // `pan-x` tells the browser this element only handles
            // horizontal panning — vertical touch gestures fall
            // through to the parent scroller (the launcher's main
            // scroll area). Without this, a near-vertical swipe on
            // the strip was getting captured by the horizontal
            // scroller's touch zone and neither direction scrolled
            // cleanly.
            touchAction: 'pan-x',
            // Hide the horizontal scrollbar on mobile — the scroll is
            // touch-driven and the bar would steal vertical space.
            scrollbarWidth: 'none'
          }}
        >
          {featured.map((dapp, index) => (
            <div key={dapp.url} style={{ width: TILE_WIDTH, flexShrink: 0 }}>
              <DappTile
                url={dapp.url}
                name={dapp.name}
                icon={dapp.icon}
                brandColor={dapp.brandColor}
                badge={dapp.badge}
                onOpen={onOpen}
                animationIndex={index}
                // No `entryBaseDelay` override — tiles animate
                // immediately after mount (with per-index stagger),
                // WHICH OVERLAPS THE TAB SLIDE-IN TRANSFORM. This is
                // intentional: the parent's `translateX(8%) → 0`
                // animation composes with the tile's own `y: -48 → 0`
                // to produce a diagonal "drop in from top right"
                // motion that matches Recents (which also mounts
                // during the tab transition, via its async data
                // load). Earlier we delayed past the transition to
                // isolate the drop, but that produced a PURELY
                // vertical fall while Recents got the diagonal —
                // visually inconsistent.
              />
            </div>
          ))}
        </div>
        {/* Left chevron — absolute overlay vertically centered on the
            tile strip. Appears only when (a) there are more than the
            overflow threshold of tiles, (b) content actually overflows
            the viewport, and (c) there's scroll distance to the left
            (user has already scrolled right). */}
        {couldOverflow && canScrollLeft && (
          <button
            type="button"
            onClick={() => handleChevronClick('left')}
            aria-label={t('scrollLeft') ?? 'Scroll left'}
            className="absolute left-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-pure-white shadow-md"
          >
            <Icon name={IconName.ChevronLeftLucide} size="sm" className="text-grey-700" />
          </button>
        )}
        {couldOverflow && canScrollRight && (
          <button
            type="button"
            onClick={() => handleChevronClick('right')}
            aria-label={t('scrollRight') ?? 'Scroll right'}
            className="absolute right-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-pure-white shadow-md"
          >
            <Icon name={IconName.ChevronRightLucide} size="sm" className="text-grey-700" />
          </button>
        )}
      </div>
    </section>
  );
};
