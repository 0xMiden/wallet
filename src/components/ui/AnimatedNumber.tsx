import React, { FC, ReactNode, useLayoutEffect, useRef } from 'react';

import { animate, useMotionValue, useReducedMotion } from 'framer-motion';

import { presets } from 'lib/animation';
import { cn } from 'lib/ui/util';

export interface AnimatedNumberProps {
  /**
   * The number to show. Anything that is not a finite number — `null` while it loads, `undefined`
   * before the first read, a `NaN` out of a division — renders `placeholder` instead, with no
   * animation and no crash.
   */
  value: number | null | undefined;
  /**
   * Turns a number into the exact string to render, INCLUDING any currency symbol, token symbol,
   * sign or percent sign. Rounding, locale and decimals belong to the caller (`lib/i18n/numbers`),
   * never here, and the whole display string has to come out of one call so it lands in one text
   * node: a suffix rendered as a sibling would split "100.00 MIDEN" across two elements.
   *
   * It is called once per animation frame while the number is travelling, so it must be cheap and
   * must not change shape with magnitude (see `adaptiveFormatterFor`), or the row will jitter.
   */
  format: (value: number) => string;
  /** What to render while `value` is not a finite number: a dash, a mask, a skeleton, nothing. */
  placeholder?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * Whether this realm may animate a number at all.
 *
 * A realm with no `matchMedia` cannot be asked whether the user wants reduced motion, and motion we
 * cannot check the preference for is motion we do not run. That is also the shape of every
 * non-browser render — jsdom has no `matchMedia` — which is why a jest test reads the settled value
 * synchronously without any timer plumbing, and why a test that wants the travelling behaviour
 * installs a `matchMedia` of its own.
 */
function realmCanAnimate(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * A number that travels to its new value instead of snapping to it.
 *
 * Wraps any figure the wallet displays — a balance, a fiat value, a token amount, a percentage, an
 * APY. It animates ON CHANGE ONLY: the first value it is given is rendered as-is, so a balance
 * never counts up from zero because a page mounted or a hidden tab pane came back into view. (Tab
 * panes here stay mounted, so a value that changes behind a hidden pane travels while it is hidden
 * and is already settled when the pane is shown — which is the behaviour we want.)
 *
 *   <AnimatedNumber value={balance} format={n => `$${toLocalFormat(n, { decimalPlaces: 2 })}`} />
 *
 * Under reduced motion, in any realm that cannot report the motion preference, and when the sign
 * changes, the new value is set immediately.
 *
 * It cannot tell a new subject from a new value: a figure whose subject can change while it stays
 * mounted (a picked token, pair, account or position) must be keyed by that subject's id, so a new
 * subject lands and only a new value of the same subject counts.
 */
export const AnimatedNumber: FC<AnimatedNumberProps> = ({
  value,
  format,
  placeholder = null,
  className,
  'data-testid': dataTestId
}) => {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;

  const motionValue = useMotionValue(numeric ?? 0);
  // The formatter is read per frame, from a ref, so an inline arrow at the call site does not
  // restart the animation on every parent render.
  const formatRef = useRef(format);
  formatRef.current = format;
  // What was last committed. `null` means "no number has been shown yet", which is the mount case
  // and the only one where landing on the value without travelling is right.
  const shownRef = useRef<number | null>(null);

  useLayoutEffect(
    () =>
      motionValue.on('change', latest => {
        const node = ref.current;
        // A frame can still arrive after the value has gone non-numeric; the placeholder is React's
        // to render, so the subscriber must not write over it.
        if (node && shownRef.current !== null) node.textContent = formatRef.current(latest);
      }),
    [motionValue]
  );

  // A LAYOUT effect, because React has just committed the NEW value as this span's text and the
  // animation starts from the old one. Putting the old value back has to happen before the browser
  // paints, or every change flashes its destination for a frame and then jumps back to count up to
  // it.
  useLayoutEffect(() => {
    const previous = shownRef.current;
    shownRef.current = numeric;
    if (numeric === null) return;
    // A change of sign lands instead of counting: callers style a signed figure by its destination
    // (a red or green delta, a toned pill), so a count through zero would show frames of the other
    // sign in that styling. Zero is a sign of its own, so leaving or reaching it lands too.
    if (previous === null || Math.sign(previous) !== Math.sign(numeric) || reduceMotion || !realmCanAnimate()) {
      motionValue.jump(numeric);
      return;
    }
    // Where the number is RIGHT NOW, which is not `previous` when a change interrupts a count
    // already in flight: that one is the interrupted count's destination, and starting from it
    // would jump the number forward before sending it back.
    const node = ref.current;
    if (node) node.textContent = formatRef.current(motionValue.get());
    const controls = animate(motionValue, numeric, presets.count.transition);
    return () => controls.stop();
  }, [numeric, reduceMotion, motionValue]);

  return (
    <span
      ref={ref}
      data-testid={dataTestId}
      // Intermediate values are not news. `aria-live="off"` on the element that mutates opts it out
      // of any live region an ancestor declares, so assistive tech is never read the count; the
      // settled value is plain text in the DOM, so reading the element on demand gives the number.
      aria-live="off"
      // Tabular figures: every digit is the same width, so a travelling number changes what it says
      // without changing how wide it is, and the row beside it holds still.
      className={cn(numeric !== null && 'tabular-nums', className)}
    >
      {numeric === null ? placeholder : format(numeric)}
    </span>
  );
};

export default AnimatedNumber;
