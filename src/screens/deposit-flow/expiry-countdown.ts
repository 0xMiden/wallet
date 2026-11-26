import { useEffect, useState } from 'react';

/** The time between two updates of a countdown. */
export const COUNTDOWN_TICK_MS = 1000;

/** The time that is left, as "m:ss" (mock-up `clock()`), or "h:mm:ss" from one hour. "0:00" for a time in the past. */
export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * The milliseconds that are left until `expiresAt` (Unix milliseconds), never less than zero. It changes each second
 * and stops at zero. Only the component that calls it renders again each second.
 */
export function useCountdown(expiresAt: number): number {
  const [left, setLeft] = useState(() => Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const read = () => Math.max(0, expiresAt - Date.now());
    const first = read();
    setLeft(first);
    if (first === 0) return undefined;
    const timer = window.setInterval(() => {
      const next = read();
      setLeft(next);
      if (next === 0) window.clearInterval(timer);
    }, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return left;
}

/**
 * True once `deadline` (Unix milliseconds) is in the past. It sets one timer to the deadline, not a timer each second,
 * so the component that calls it renders again only when the deadline passes. NaN never passes.
 */
export function useDeadlinePassed(deadline: number): boolean {
  const [passed, setPassed] = useState(() => Number.isFinite(deadline) && Date.now() >= deadline);
  useEffect(() => {
    let timer: number | undefined;
    const check = () => {
      if (!Number.isFinite(deadline)) {
        setPassed(false);
        return;
      }
      const remaining = deadline - Date.now();
      setPassed(remaining <= 0);
      // A timer can fire early, and a browser timer holds at most 2^31 - 1 ms: the check sets it again.
      if (remaining > 0) timer = window.setTimeout(check, Math.min(remaining, MAX_TIMER_MS));
    };
    check();
    return () => window.clearTimeout(timer);
  }, [deadline]);
  return passed;
}

/** The longest delay that a browser timer holds. */
const MAX_TIMER_MS = 2_147_483_647;
