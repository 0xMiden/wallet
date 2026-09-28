import { useEffect, useState } from 'react';

import { probeHardwareProtector } from 'lib/miden/back/protector-probe';

export interface HardwareProtectorProbe {
  /** `null` until the probe answers, and for good when it fails: never a guessed credential. */
  hasHardwareProtector: boolean | null;
  /** Both protector reads failed, so no credential gate can be chosen and the page shows an error. */
  probeFailed: boolean;
}

/**
 * The mount-time protector probe for a page that gates an action on the wallet's credential.
 *
 * The failure is a separate flag, not a third value of `hasHardwareProtector`: pages branch on
 * `if (!hasHardwareProtector)`, and any sentinel other than `null` would route by truthiness.
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
