import React, {
  Children,
  FC,
  isValidElement,
  Key,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

import classNames from 'clsx';
import { animate, motion, PanInfo, useMotionValue } from 'framer-motion';

import { springs } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

export interface PromptCarouselProps {
  /**
   * Each child becomes a slide. Falsy children (e.g. a banner component that
   * returns `null` when not applicable) are filtered out — pass a static list
   * of all possible prompts and let each decide whether to render.
   */
  children: ReactNode;
  className?: string;
}

const COMMIT_THRESHOLD = 0.3;
const VELOCITY_PROJECTION_MS = 300;
const SLIDE_GAP_PX = 12;

// The one name of a slide, for React's reconciliation and for the selection alike.
const slideKey = (slide: ReactNode, index: number): Key =>
  isValidElement(slide) && slide.key !== null ? slide.key : index;

/**
 * Horizontal carousel that wraps a list of prompts with optional drag-paging
 * and dot indicators. Behavior collapses gracefully:
 *  - 0 visible prompts → renders nothing
 *  - 1 visible prompt  → no dots, no drag, no gesture claim
 *  - 2+ visible        → draggable track + dot row
 * Every count renders through the same tree, with each slide keyed by its own key,
 * so a slide never remounts when a sibling appears or disappears: a card that swaps
 * its content in the same render keeps its DOM, and the user's focus in it.
 */
export const PromptCarousel: FC<PromptCarouselProps> = ({ children, className }) => {
  const slides = Children.toArray(children).filter(Boolean);
  const slideKeys = slides.map(slideKey);
  const paging = slides.length > 1;
  // Held as state (callback ref) rather than a plain ref: the track div does not
  // exist while there are no slides, so setup effects must re-run when it mounts;
  // with a plain ref and [] deps they would observe null forever.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const releaseClickTimerRef = useRef<number | null>(null);
  const x = useMotionValue(0);
  const [width, setWidth] = useState(0);
  // What is on stage, by key, so a sibling appearing or disappearing before it moves its
  // position, not the choice. A page (a dot, a drag, or focus moving into a slide off stage)
  // lasts while its slide exists; focus inside the slide on stage holds it only while focus
  // stays in the carousel. With neither, the first slide shows, so a prompt that arrives
  // ahead of the others (they come in priority order) takes the stage.
  const [pageKey, setPageKey] = useState<Key | null>(null);
  const [focusKey, setFocusKey] = useState<Key | null>(null);
  // Set when the user pages, so only that move springs; a slide-list change places
  // the track at once, before paint, instead of sliding the selected card away.
  // Placing uses jump, not set: set leaves a running spring (a drag's snap-back) to
  // pull the track back to the old offset.
  const pagedRef = useRef(false);

  // Computed inline so a slide disappearing mid-flight (e.g. ActivateHotKeyBanner
  // returning null once the rotation lands) never leaves the track translated
  // off-screen waiting for the effect below to catch up.
  const pageIndex = pageKey === null ? -1 : slideKeys.indexOf(pageKey);
  const focusIndex = focusKey === null ? -1 : slideKeys.indexOf(focusKey);
  const activeIndex = pageIndex >= 0 ? pageIndex : Math.max(0, focusIndex);

  // A choice whose slide has gone is dropped, so the slide coming back later does not take
  // the stage again. Only the key seen here is cleared: a newer choice queued meanwhile stays.
  useEffect(() => {
    if (pageKey !== null && pageIndex < 0) setPageKey(current => (current === pageKey ? null : current));
    if (focusKey !== null && focusIndex < 0) setFocusKey(current => (current === focusKey ? null : current));
  }, [focusIndex, focusKey, pageIndex, pageKey]);

  const selectSlide = (i: number) => {
    pagedRef.current = true;
    setPageKey(slideKeys[i] ?? null);
  };

  // Focus moving into a slide off stage pages to it; focus inside the slide on stage keeps it
  // there while focus stays in the carousel, so a prompt arriving ahead does not push it away.
  const handleSlideFocus = (i: number) => {
    if (i !== activeIndex) selectSlide(i);
    else setFocusKey(slideKeys[i] ?? null);
  };

  useLayoutEffect(() => {
    if (!container) return;
    setWidth(container.clientWidth);
  }, [container]);

  useEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [container]);

  useEffect(() => {
    if (!container || !paging) return;

    // HomePrompts sits inside HomeSwipeContainer, which is another horizontal
    // Framer Motion drag surface. Let the prompt track start its drag session,
    // then stop pointer-down from bubbling into the page-level carousel.
    const claimPromptGesture = (event: PointerEvent) => event.stopPropagation();
    container.addEventListener('pointerdown', claimPromptGesture);
    return () => container.removeEventListener('pointerdown', claimPromptGesture);
  }, [container, paging]);

  useEffect(
    () => () => {
      if (releaseClickTimerRef.current !== null) window.clearTimeout(releaseClickTimerRef.current);
    },
    []
  );

  // Each slide occupies `width` px followed by a SLIDE_GAP_PX gutter, so
  // paging steps by width + gap rather than width alone.
  const step = width + SLIDE_GAP_PX;

  // Runs on `paging` too: a slide-list change that turns drag off without moving the
  // selection (the other slide going mid-drag) must still settle the track.
  useLayoutEffect(() => {
    const paged = pagedRef.current;
    pagedRef.current = false;
    if (!width) {
      const fallbackWidth = container?.clientWidth ?? 0;
      x.jump(-activeIndex * (fallbackWidth ? fallbackWidth + SLIDE_GAP_PX : 0));
      return;
    }
    if (!paged) {
      x.jump(-activeIndex * step);
      return;
    }
    const controls = animate(x, -activeIndex * step, springs.standard);
    return () => controls.stop();
  }, [activeIndex, container, paging, step, width, x]);

  const handleDragStart = () => {
    if (releaseClickTimerRef.current !== null) window.clearTimeout(releaseClickTimerRef.current);
    suppressClickRef.current = true;
  };

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    if (width) {
      const projected = info.offset.x + info.velocity.x * (VELOCITY_PROJECTION_MS / 1000);
      let nextIdx = activeIndex;
      if (projected < -width * COMMIT_THRESHOLD && activeIndex < slides.length - 1) nextIdx = activeIndex + 1;
      else if (projected > width * COMMIT_THRESHOLD && activeIndex > 0) nextIdx = activeIndex - 1;
      if (nextIdx !== activeIndex) {
        hapticSelection();
        selectSlide(nextIdx);
      } else {
        animate(x, -activeIndex * step, springs.standard);
      }
    }

    // Browsers may dispatch a click immediately after pointer-up. Keep the
    // guard through that click, then restore normal card/CTA interaction.
    releaseClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      releaseClickTimerRef.current = null;
    }, 0);
  };

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDotTap = (i: number) => {
    if (i === activeIndex) return;
    hapticSelection();
    selectSlide(i);
  };

  if (slides.length === 0) return null;

  const dragMaxLeft = width ? -(slides.length - 1) * step : 0;

  return (
    <div
      className={classNames('flex flex-col gap-2', className)}
      onBlur={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
          setFocusKey(null);
        }
      }}
    >
      <div
        ref={setContainer}
        className={classNames('w-full overflow-hidden', paging && 'touch-pan-y')}
        // Only the track's transform moves the slides. A browser scrolls this overflow-hidden
        // viewport to reveal a control focused in a hidden slide, and that offset would add to
        // the page focus moves the track by. (overflow: clip would stop it, but not on iOS 15.)
        onScroll={event => {
          if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0;
        }}
      >
        <motion.div
          className="flex items-start"
          style={{ x, gap: SLIDE_GAP_PX }}
          drag={paging ? 'x' : false}
          dragDirectionLock
          dragConstraints={{ left: dragMaxLeft, right: 0 }}
          dragElastic={0.15}
          dragMomentum={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClickCapture={handleClickCapture}
        >
          {slides.map((slide, i) => (
            <div
              key={slideKey(slide, i)}
              className="shrink-0"
              style={{ width: width || '100%' }}
              onFocus={() => handleSlideFocus(i)}
            >
              {slide}
            </div>
          ))}
        </motion.div>
      </div>
      {paging && (
        <div className="flex justify-center gap-1.5">
          {slides.map((slide, i) => (
            <button
              key={slideKey(slide, i)}
              type="button"
              onClick={() => handleDotTap(i)}
              aria-label={`Show prompt ${i + 1} of ${slides.length}`}
              className={classNames(
                'h-1.5 rounded-full transition-all',
                i === activeIndex ? 'w-4 bg-accent-primary' : 'w-1.5 bg-fill'
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default PromptCarousel;
