import { FC, useEffect, useRef } from 'react';

// Deep imports on purpose: the `lib/deposit-bridge` barrel re-exports
// `execute.ts`, which pulls the Epoch SDK + the whole wallet store into every
// module that touches it. This only needs the store, and it is mounted from
// `TabLayout` — the top of the app tree — so the barrel's weight is not worth
// paying here.
import { useDepositAddressStore } from 'lib/deposit-bridge/store';
import { isDepositAddressBridgeEnabled } from 'lib/feature-flags';
import { navigate, useLocation } from 'lib/woozie';

/**
 * Picks up a deposit nobody asked for.
 *
 * Money can land on the derived address at any time — someone paid it from an
 * exchange, or the user requested it in a session that has since ended. When it
 * does, the wallet opens the same waiting screen the requested flow uses, on the
 * "confirming on Sepolia" step, and that screen moves on to the bridge review
 * once the arrival is final.
 *
 * Deliberately renders nothing: this replaced a "funds arrived" sheet, and a
 * sheet on top of whatever the user was doing is worse than taking them to the
 * one screen that can act on it.
 */
export const DepositArrivalRouter: FC = () => {
  const { pathname } = useLocation();
  const detectedArrivals = useDepositAddressStore(store => store.detectedArrivals);
  const arrival = detectedArrivals[0] ?? null;

  // One navigation per arrival. Keyed on token+balance so a LATER, larger
  // deposit re-opens the screen while the same one never does.
  const routedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isDepositAddressBridgeEnabled() || !arrival) return;
    // Never yank the user out of a bridge that is already underway, or off the
    // screens that are already showing these same funds.
    if (pathname.startsWith('/deposit-bridge') || pathname.startsWith('/generating-transaction')) return;

    const key = `${arrival.token}:${arrival.balance.toString()}`;
    if (routedKeyRef.current === key) return;
    routedKeyRef.current = key;

    const params = new URLSearchParams({
      token: arrival.token,
      amount: arrival.amount.toString(),
      method: 'address'
    });
    navigate(`/deposit-bridge/approve?${params.toString()}`);
  }, [arrival, pathname]);

  return null;
};
