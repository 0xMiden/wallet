import { useCallback, useState } from 'react';

import { type DepositToken, sameDepositToken } from './deposit-token';

/**
 * The token the deposit screen bridges. Picking a different token switches it and calls `onChange`, which clears what
 * belonged to the old token (its Epoch quote, a Slow attempt). Picking the selected token again changes nothing: no
 * effect would re-quote after a reset, so Fast would stay unconfirmable.
 */
export function useDepositToken(
  onChange: () => void,
  initialToken: DepositToken = 'CIRCLE_USDC'
): {
  token: DepositToken;
  selectToken: (next: DepositToken) => void;
} {
  const [token, setToken] = useState<DepositToken>(initialToken);
  const selectToken = useCallback(
    (next: DepositToken) => {
      if (sameDepositToken(next, token)) return;
      setToken(next);
      onChange();
    },
    [onChange, token]
  );
  return { token, selectToken };
}
