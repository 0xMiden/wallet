import React, { useEffect, useRef, useState } from 'react';

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';

import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { ACCENT_CLASSES, type FlowAccent } from 'components/flow/accent';
import { durations, easings, resolveTransition, springs } from 'lib/animation';
import { hapticSuccess } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

/** The knob travels this share of the track, or more, to confirm. */
export const SLIDE_CONFIRM_THRESHOLD = 0.9;
/** A press that moves the knob less than this many pixels is a tap: the knob nudges to show that it slides. */
const TAP_SLOP_PX = 4;
/** How far the nudge moves the knob. */
const NUDGE_PX = 20;
/** The knob's 4px inset on each side of the track. */
const KNOB_INSET_PX = 8;
/** The label fades out over the first part of the travel: gone at 1 / 1.6 of it. */
const LABEL_FADE_RATE = 1.6;

/**
 * The knob's glyph: the flow's card colour pinned to its light value (`--qr-*`), because the knob is
 * always a white disc, like the QR tile.
 */
const KNOB_GLYPH: Record<FlowAccent, string> = {
  brand: 'text-[var(--qr-orange)]',
  send: 'text-[var(--qr-blue)]',
  receive: 'text-[var(--qr-green)]',
  earn: 'text-[var(--qr-slate)]',
  swap: 'text-[var(--qr-purple)]'
};

export interface SlideToConfirmProps {
  /** What the slide does, such as "Slide to show deposit address". It is also the knob's accessible name. */
  label: string;
  /** Called once, when the knob reaches the end or a keyboard user confirms. */
  onConfirm: () => void;
  disabled?: boolean;
  /** The flow colour of the track. Defaults to the brand orange. */
  accent?: FlowAccent;
  /** A new value puts the knob back at the start, so the user can slide again (for example after a failure). */
  resetKey?: string | number;
  /** Layout only. */
  className?: string;
  'data-testid'?: string;
}

/**
 * A slide control for a step that must not start by accident. The user drags the knob across the
 * track; it confirms at 90% of the travel and springs back below that. A tap nudges the knob.
 * Enter, Space and the right arrow confirm from the keyboard, and an assistive-technology click
 * confirms too. Under reduced motion the knob moves at once and does not nudge.
 */
export const SlideToConfirm: React.FC<SlideToConfirmProps> = ({
  label,
  onConfirm,
  disabled = false,
  accent = 'brand',
  resetKey,
  className,
  'data-testid': dataTestId
}) => {
  const reduce = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLButtonElement>(null);
  const maxRef = useRef(0);
  const dragRef = useRef<{ startX: number } | null>(null);
  const doneRef = useRef(false);
  const [done, setDone] = useState(false);
  const x = useMotionValue(0);
  const labelOpacity = useTransform(x, value =>
    maxRef.current > 0 ? Math.max(0, 1 - (value / maxRef.current) * LABEL_FADE_RATE) : 1
  );

  useEffect(() => {
    doneRef.current = false;
    setDone(false);
    x.set(0);
  }, [resetKey, x]);

  const measure = () => {
    const track = trackRef.current;
    const knob = knobRef.current;
    maxRef.current = track && knob ? Math.max(0, track.clientWidth - knob.offsetWidth - KNOB_INSET_PX) : 0;
  };

  const complete = () => {
    if (disabled || doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    measure();
    animate(x, maxRef.current, resolveTransition(reduce, springs.snappy));
    hapticSuccess();
    onConfirm();
  };

  const release = (moved: number) => {
    animate(x, 0, resolveTransition(reduce, springs.dragRelease));
    if (moved < TAP_SLOP_PX && !reduce) {
      animate(x, [0, NUDGE_PX, 0], { duration: durations.slow, times: [0, 0.4, 1], ease: easings.standard });
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || doneRef.current) return;
    measure();
    dragRef.current = { startX: event.clientX };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A realm without pointer capture still gets the moves while the pointer stays on the knob.
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    x.set(Math.min(maxRef.current, Math.max(0, event.clientX - drag.startX)));
  };

  const onPointerEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const moved = x.get();
    if (maxRef.current > 0 && moved >= maxRef.current * SLIDE_CONFIRM_THRESHOLD) complete();
    else release(moved);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'ArrowRight':
        event.preventDefault();
        complete();
        break;
      default:
        break;
    }
  };

  const tone = ACCENT_CLASSES[accent];

  return (
    <div
      ref={trackRef}
      data-testid={dataTestId}
      data-done={done ? 'true' : 'false'}
      className={cn(
        'relative flex h-14 shrink-0 select-none items-center justify-center overflow-hidden rounded-full pr-4 pl-15',
        tone.bg,
        disabled && 'opacity-40',
        className
      )}
    >
      <motion.span
        aria-hidden="true"
        style={{ opacity: labelOpacity }}
        className={cn('whitespace-nowrap text-row-title leading-snug font-extrabold', tone.on)}
      >
        {label}
      </motion.span>
      <motion.button
        ref={knobRef}
        type="button"
        aria-label={label}
        disabled={disabled}
        style={{ x }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        // A click with no pointer behind it (detail 0) comes from assistive technology: it confirms.
        onClick={event => {
          if (event.detail === 0) complete();
        }}
        data-testid={dataTestId && `${dataTestId}-knob`}
        className={cn(
          'absolute top-1 left-1 grid size-12 cursor-grab touch-none place-items-center rounded-full bg-pure-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] active:cursor-grabbing disabled:cursor-default',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pure-white',
          KNOB_GLYPH[accent]
        )}
      >
        <ChevronRightIcon aria-hidden="true" className="pointer-events-none size-[22px] stroke-current" />
      </motion.button>
    </div>
  );
};
