/**
 * React binding for the guardian auto-detection probe (issue #418).
 *
 * Owns the run-token / AbortController bookkeeping so both onboarding hosts —
 * `app/pages/Welcome.tsx` (which shows the result on the recovery-method
 * screen) and `app/pages/ForgotPassword/ForgotPassword.tsx` (which has no such
 * screen and just rides the result into `register()`) — behave identically.
 *
 * `lib/miden/guardian/discover` and `lib/miden/sdk/derive-seed` are imported
 * DYNAMICALLY: they pull the guardian client and the WASM SDK, which must not
 * land in the onboarding chunk that renders the very first screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GuardianDiscoveryResult } from 'lib/miden/guardian/discover';
import type { GuardianProbeState } from 'screens/onboarding/types';

/**
 * How long a caller that must block on the probe (ForgotPassword) waits before
 * giving up and registering with the stored endpoint. Deliberately short: the
 * probe has been running since seed entry (usually resolved long before the
 * user finishes their passcode), the stored endpoint is used on timeout anyway,
 * and blocking the final confirmation button for the probe's full worst case
 * would be 20s of pure waiting for what is normally just a refinement.
 */
export const GUARDIAN_PROBE_WAIT_DEADLINE_MS = 5_000;

/** Normalize a seed-phrase word array into the mnemonic string BIP-39 expects. */
function toMnemonic(words: readonly string[]): string {
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

export interface GuardianProbeController {
  /** Current probe progress, safe to hand straight to `ImportRecoveryMethodScreen`. */
  state: GuardianProbeState;
  /**
   * Start (or restart) a probe for `words`. Resolves with the discovery result,
   * or `undefined` when the probe failed or was superseded by a newer run.
   * Never rejects — detection failing is an expected, recoverable outcome.
   */
  start: (words: readonly string[]) => Promise<GuardianDiscoveryResult | undefined>;
  /** Abort any in-flight probe and return to `idle` (e.g. backing out to seed entry). */
  reset: () => void;
}

export function useGuardianProbe(): GuardianProbeController {
  const [state, setState] = useState<GuardianProbeState>({ status: 'idle' });
  // Monotonic token: only the newest run may publish. A stale probe finishing
  // late must not clobber the result of the seed the user actually entered.
  const runToken = useRef(0);
  const abortController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortController.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    runToken.current += 1;
    abortController.current?.abort();
    abortController.current = null;
    setState({ status: 'idle' });
  }, []);

  const start = useCallback(async (words: readonly string[]): Promise<GuardianDiscoveryResult | undefined> => {
    runToken.current += 1;
    const token = runToken.current;

    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;

    setState({ status: 'probing' });

    try {
      const [{ discoverGuardianForSeed }, { makeColdSeedDeriver }] = await Promise.all([
        import('lib/miden/guardian/discover'),
        import('lib/miden/sdk/derive-seed')
      ]);

      const result = await discoverGuardianForSeed(makeColdSeedDeriver(toMnemonic(words)), {
        signal: controller.signal
      });

      if (token !== runToken.current) return undefined;
      if (mounted.current) setState({ status: 'done', result });
      return result;
    } catch (error) {
      console.warn('[guardian/probe] Auto-detection failed, falling back to the manual picker:', error);
      if (token !== runToken.current) return undefined;
      if (mounted.current) {
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return undefined;
    }
  }, []);

  return { state, start, reset };
}
