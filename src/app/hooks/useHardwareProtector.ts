import { useCallback, useEffect, useRef, useState } from 'react';

import { probeHardwareProtector } from 'lib/miden/back/protector-probe';

/** How long the protector read may take before the page says so; the read is plain storage and answers in ms. */
export const PROTECTOR_PROBE_DEADLINE_MS = 5_000;

export interface HardwareProtectorProbe {
  /**
   * `null` until the probe answers, and while it is failed. `null` is falsy, so a truthiness route
   * would send it to the password step: check `=== null` before routing.
   */
  hasHardwareProtector: boolean | null;
  /** No answer: both protector reads failed, or the probe missed its deadline. The page shows an error with Retry. */
  probeFailed: boolean;
  /** A Retry is in flight. `probeFailed` stays set until it settles, so the error stays on screen. */
  retrying: boolean;
  /** Probes again. Does nothing unless the probe failed and no Retry is in flight. */
  retry: () => void;
}

/**
 * The mount-time protector probe for a page that gates an action on the wallet's credential.
 *
 * Every consumer disables its gated action or returns early on `hasHardwareProtector === null`
 * (pending, or failed) before any `hasHardwareProtector ? hardware : password` route, and renders
 * `probeFailed` before its form so the page says why no credential step appeared. The failure is a
 * separate flag rather than a third value because every guard compares `=== null`: any other
 * failed-state value would get past it and route by truthiness.
 *
 * An answer is adopted whenever it arrives, even after the deadline or from an attempt a Retry has
 * superseded: it reads which protector key is stored, which does not change while the page is open.
 * A failure counts only for the latest attempt, so an old attempt cannot fail a Retry still running.
 */
export function useHardwareProtector(): HardwareProtectorProbe {
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Refs, because settle callbacks of earlier attempts read them after later renders.
  const latestAttempt = useRef(0);
  const answered = useRef(false);
  const failed = useRef(false);
  const retryInFlight = useRef(false);
  const mounted = useRef(false);
  const deadline = useRef<ReturnType<typeof setTimeout>>();

  const fail = useCallback(() => {
    failed.current = true;
    retryInFlight.current = false;
    setProbeFailed(true);
    setRetrying(false);
  }, []);

  const probe = useCallback(() => {
    const attempt = ++latestAttempt.current;
    let missedDeadline = false;
    clearTimeout(deadline.current);
    deadline.current = setTimeout(() => {
      if (!mounted.current || answered.current || attempt !== latestAttempt.current) return;
      missedDeadline = true;
      console.warn(`[useHardwareProtector] protector probe did not answer within ${PROTECTOR_PROBE_DEADLINE_MS}ms`);
      fail();
    }, PROTECTOR_PROBE_DEADLINE_MS);

    probeHardwareProtector().then(
      hasHardware => {
        if (!mounted.current || answered.current) return;
        if (missedDeadline) console.warn('[useHardwareProtector] protector probe answered after the deadline');
        answered.current = true;
        failed.current = false;
        retryInFlight.current = false;
        clearTimeout(deadline.current);
        setHasHardwareProtector(hasHardware);
        setProbeFailed(false);
        setRetrying(false);
      },
      (error: unknown) => {
        if (!mounted.current || answered.current || attempt !== latestAttempt.current) return;
        clearTimeout(deadline.current);
        console.warn(
          `[useHardwareProtector] protector probe failed: ${error instanceof Error ? error.message : String(error)}`
        );
        fail();
      }
    );
  }, [fail]);

  useEffect(() => {
    mounted.current = true;
    probe();
    return () => {
      mounted.current = false;
      clearTimeout(deadline.current);
    };
  }, [probe]);

  const retry = useCallback(() => {
    if (!mounted.current || answered.current || !failed.current || retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    probe();
  }, [probe]);

  return { hasHardwareProtector, probeFailed, retrying, retry };
}
