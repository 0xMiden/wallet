import { useEffect, useState } from 'react';

import { probeHardwareProtector } from 'lib/miden/back/protector-probe';

export interface HardwareProtectorProbe {
  /**
   * `null` until the probe answers, and stays `null` for good if it fails. `null` is falsy, so a
   * truthiness route would send it to the password step: check `=== null` before routing.
   */
  hasHardwareProtector: boolean | null;
  /** Both protector reads failed, so no credential gate can be chosen and the page shows an error. */
  probeFailed: boolean;
}

/**
 * The mount-time protector probe for a page that gates an action on the wallet's credential.
 *
 * Every consumer disables its gated action or returns early on `hasHardwareProtector === null`
 * (pending, or failed for good) before any `hasHardwareProtector ? hardware : password` route,
 * and renders `probeFailed` before its form so the page says why no credential step appeared.
 * The failure is a separate flag rather than a third value because every guard compares
 * `=== null`: any other failed-state value would get past it and route by truthiness.
 */
export function useHardwareProtector(): HardwareProtectorProbe {
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);

  useEffect(() => {
    probeHardwareProtector().then(setHasHardwareProtector, (error: unknown) => {
      console.warn(
        `[useHardwareProtector] protector probe failed: ${error instanceof Error ? error.message : String(error)}`
      );
      setProbeFailed(true);
    });
  }, []);

  return { hasHardwareProtector, probeFailed };
}
