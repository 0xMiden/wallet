import { useEffect, useState } from 'react';

import { probeHardwareProtector } from 'lib/miden/back/protector-probe';

export interface HardwareProtectorProbe {
  /**
   * `null` until the probe answers, and stays `null` for good if it fails: always falsy, so a
   * consumer that has not yet learned the real value never guesses a credential. Every consumer
   * must refuse to act (disable the gated action or return early) while this is `null`.
   */
  hasHardwareProtector: boolean | null;
  /** Both protector reads failed, so no credential gate can be chosen and the page shows an error. */
  probeFailed: boolean;
}

/**
 * The mount-time protector probe for a page that gates an action on the wallet's credential.
 *
 * `hasHardwareProtector` is the one value every consumer already blocks on: `null` while pending
 * and `null` again on failure, so `if (!hasHardwareProtector)` alone keeps a page from acting on
 * a guess. The failure is a separate flag, not a third value of `hasHardwareProtector` (any
 * sentinel other than `null` would route by truthiness instead), and it is a signal to render:
 * consumers must show `probeFailed` before their form so the page explains why no credential step
 * appeared instead of leaving it looking merely pending.
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
