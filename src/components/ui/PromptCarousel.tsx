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

/**
 * Horizontal carousel that wraps a list of prompts with optional drag-paging
 * and dot indicators. Behavior collapses gracefully:
 *  - 0 visible prompts → renders nothing
 *  - 1 visible prompt  → renders the slide bare, no carousel chrome
 *  - 2+ visible        → draggable track + dot row
 */
export const PromptCarousel: FC<PromptCarouselProps> = ({ children, className }) => {
  const slides = Children.toArray(children).filter(Boolean);
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);

  // Compute the visible index inline so a slide disappearing mid-flight
  // (e.g. a self-gating banner returning null once its condition clears)
  // doesn't briefly leave the track translated off-screen waiting for the
  // clamp effect below to catch up.
  const activeIndex = Math.min(index, Math.max(0, slides.length - 1));

  // Persist the clamp so state stays in sync with what's actually rendered.
  useEffect(() => {
    if (index !== activeIndex) setIndex(activeIndex);
  }, [activeIndex, index]);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    setWidth(containerRef.current.clientWidth);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width) {
      x.set(-activeIndex * (containerRef.current?.clientWidth ?? 0));
      return;
    }
    const controls = animate(x, -activeIndex * width, springs.standard);
    return () => controls.stop();
  }, [activeIndex, width, x]);

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    if (!width) return;
    const projected = info.offset.x + info.velocity.x * (VELOCITY_PROJECTION_MS / 1000);
    let nextIdx = activeIndex;
    if (projected < -width * COMMIT_THRESHOLD && activeIndex < slides.length - 1) nextIdx = activeIndex + 1;
    else if (projected > width * COMMIT_THRESHOLD && activeIndex > 0) nextIdx = activeIndex - 1;
    if (nextIdx !== activeIndex) {
      hapticSelection();
      setIndex(nextIdx);
    } else {
      animate(x, -activeIndex * width, springs.standard);
    }
  };

  const handleDotTap = (i: number) => {
    if (i === activeIndex) return;
    hapticSelection();
    setIndex(i);
  };

  if (slides.length === 0) return null;
  if (slides.length === 1) return <div className={className}>{slides[0]}</div>;

  const dragMaxLeft = width ? -(slides.length - 1) * width : 0;

  return (
    <div className={classNames('flex flex-col gap-2', className)}>
      <div ref={containerRef} className="w-full overflow-hidden touch-pan-y">
        <motion.div
          className="flex items-start"
          style={{ x, width: `${slides.length * 100}%` }}
          drag="x"
          dragDirectionLock
          dragConstraints={{ left: dragMaxLeft, right: 0 }}
          dragElastic={0.15}
          dragMomentum={false}
          onDragEnd={handleDragEnd}
        >
          {slides.map((slide, i) => (
            <div key={i} className="shrink-0" style={{ width: `${100 / slides.length}%` }}>
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
