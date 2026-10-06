import { useCallback, useState } from 'react';

import type { DepositToken } from './EvmBridgeTokenDrawer';

/**
 * The token the deposit screen bridges. Picking a different token switches it and calls `onChange`, which clears what
 * belonged to the old token (its Epoch quote, a Slow attempt). Picking the selected token again changes nothing: no
 * effect would re-quote after a reset, so Fast would stay unconfirmable.
 */
export function useDepositToken(onChange: () => void): {
  token: DepositToken;
  selectToken: (next: DepositToken) => void;
} {
  const [token, setToken] = useState<DepositToken>('USDC');
  const selectToken = useCallback(
    (next: DepositToken) => {
      if (next === token) return;
      setToken(next);
      onChange();
    },
    [onChange, token]
  );
  return { token, selectToken };
}
