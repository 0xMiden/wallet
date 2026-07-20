import React, { Children, FC, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/**
 * Horizontal carousel that wraps a list of prompts with optional drag-paging
 * and dot indicators. Behavior collapses gracefully:
 *  - 0 visible prompts → renders nothing
 *  - 1 visible prompt  → renders the slide bare, no carousel chrome
 *  - 2+ visible        → draggable track + dot row
 */
export const PromptCarousel: FC<PromptCarouselProps> = ({ children, className }) => {
  const slides = Children.toArray(children).filter(Boolean);
  // Held as state (callback ref) rather than a plain ref: the track div only
  // exists once there are 2+ slides, so setup effects must re-run when it
  // (un)mounts — with a plain ref and [] deps they'd observe null forever
  // whenever the carousel mounts with 0/1 slides.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const releaseClickTimerRef = useRef<number | null>(null);
  const x = useMotionValue(0);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);

  // Compute the visible index inline so a slide disappearing mid-flight
  // (e.g. ActivateHotKeyBanner returning null once the rotation lands)
  // doesn't briefly leave the track translated off-screen waiting for the
  // clamp effect below to catch up.
  const activeIndex = Math.min(index, Math.max(0, slides.length - 1));

  // Persist the clamp so state stays in sync with what's actually rendered.
  useEffect(() => {
    if (index !== activeIndex) setIndex(activeIndex);
  }, [activeIndex, index]);

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
    if (!container) return;

    // HomePrompts sits inside HomeSwipeContainer, which is another horizontal
    // Framer Motion drag surface. Let the prompt track start its drag session,
    // then stop pointer-down from bubbling into the page-level carousel.
    const claimPromptGesture = (event: PointerEvent) => event.stopPropagation();
    container.addEventListener('pointerdown', claimPromptGesture);
    return () => container.removeEventListener('pointerdown', claimPromptGesture);
  }, [container]);

  useEffect(
    () => () => {
      if (releaseClickTimerRef.current !== null) window.clearTimeout(releaseClickTimerRef.current);
    },
    []
  );

  // Each slide occupies `width` px followed by a SLIDE_GAP_PX gutter, so
  // paging steps by width + gap rather than width alone.
  const step = width + SLIDE_GAP_PX;

  useEffect(() => {
    if (!width) {
      const fallbackWidth = container?.clientWidth ?? 0;
      x.set(-activeIndex * (fallbackWidth ? fallbackWidth + SLIDE_GAP_PX : 0));
      return;
    }
    const controls = animate(x, -activeIndex * step, springs.standard);
    return () => controls.stop();
  }, [activeIndex, container, step, width, x]);

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
        setIndex(nextIdx);
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
    setIndex(i);
  };

  if (slides.length === 0) return null;
  if (slides.length === 1) return <div className={className}>{slides[0]}</div>;

  const dragMaxLeft = width ? -(slides.length - 1) * step : 0;

  return (
    <div className={classNames('flex flex-col gap-2', className)}>
      <div ref={setContainer} className="w-full overflow-hidden touch-pan-y">
        <motion.div
          className="flex items-start"
          style={{ x, gap: SLIDE_GAP_PX }}
          drag="x"
          dragDirectionLock
          dragConstraints={{ left: dragMaxLeft, right: 0 }}
          dragElastic={0.15}
          dragMomentum={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClickCapture={handleClickCapture}
        >
          {slides.map((slide, i) => (
            <div key={i} className="shrink-0" style={{ width: width || '100%' }}>
              {slide}
            </div>
          ))}
        </motion.div>
      </div>
      <div className="flex justify-center gap-1.5">
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => handleDotTap(i)}
            aria-label={`Show prompt ${i + 1} of ${slides.length}`}
            className={classNames(
              'h-1.5 rounded-full transition-all',
              i === activeIndex ? 'w-4 bg-accent-primary' : 'w-1.5 bg-gray-50'
            )}
          />
        ))}
      </div>
    </div>
  );
};

export default PromptCarousel;
