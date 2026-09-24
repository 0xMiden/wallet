import { useEffect, useState } from 'react';

import { withWasmClientLock } from 'lib/miden/sdk/miden-client';

import { readUsdcxMinimumBurn } from './burn';

/** Review preflight; submission reads again so a policy change cannot bypass validation. */
export function useBurnPreflight(enabled: boolean) {
  const [minimum, setMinimum] = useState<bigint>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setMinimum(undefined);
    setError(undefined);
    withWasmClientLock(hold => readUsdcxMinimumBurn(hold)).then(
      value => {
        if (!disposed) setMinimum(value);
      },
      reason => {
        if (!disposed) setError(reason);
      }
    );
    return () => {
      disposed = true;
    };
  }, [enabled]);
  return { minimum, error, loading: enabled && minimum === undefined && error === undefined };
}
