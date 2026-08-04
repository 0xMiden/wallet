import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
// Deep imports on purpose: the `lib/deposit-bridge` barrel re-exports
// `execute.ts`, which pulls the Epoch SDK + the whole wallet store into every
// module that touches it. This drawer only needs the store, the formatter and
// the token registry, and it is mounted from `TabLayout` — the top of the app
// tree — so the barrel's import weight is not worth paying here.
import { formatBalance } from 'lib/deposit-bridge/balances';
import { DepositArrival } from 'lib/deposit-bridge/detect';
import { useDepositAddressStore } from 'lib/deposit-bridge/store';
import { getDepositToken } from 'lib/deposit-bridge/tokens';
import { isDepositAddressBridgeEnabled } from 'lib/feature-flags';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate, useLocation } from 'lib/woozie';

/**
 * The only "funds arrived" surface for the deposit-address bridge (no home
 * prompt card — see the plan's user decision #2). Purely a store subscriber:
 * `useDepositAddressStore.pendingDrawer` is set by the poller once an arrival
 * clears the confirmation threshold.
 *
 * Two things are deliberate here:
 *
 * 1. **The arrival is latched into local state.** `markDrawerShown(token)`
 *    clears `pendingDrawer` in the store, so binding `open` straight to
 *    `pendingDrawer !== null` would slam the sheet shut the moment we
 *    acknowledge the show. We copy the arrival locally and own the open state.
 * 2. **Only `markDrawerShown` is called** — never `acknowledge`/`dismiss`.
 *    Closing or tapping "Later" must NOT raise the acknowledged watermark: the
 *    Cross-chain tab footer stays the persistent entry point, and only a
 *    successful bridge acknowledges. `markDrawerShown` is the once-per-balance
 *    gate, so a later, larger deposit re-opens the drawer.
 */

/**
 * Don't interrupt a bridge that is already underway, and don't stack on top of
 * the surface that already shows the same funds. While suppressed we also skip
 * `markDrawerShown`, so the arrival is still pending once the user leaves.
 */
function isSuppressedLocation(pathname: string, search: string): boolean {
  if (pathname.startsWith('/generating-transaction')) return true;
  if (pathname === '/receive') {
    return new URLSearchParams(search).get('tab') === 'crosschain';
  }
  return false;
}

export const DepositArrivalDrawer: FC = () => {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const pendingDrawer = useDepositAddressStore(store => store.pendingDrawer);
  const markDrawerShown = useDepositAddressStore(store => store.markDrawerShown);

  const [arrival, setArrival] = useState<DepositArrival | null>(null);
  const shownKeyRef = useRef<string | null>(null);

  const enabled = isDepositAddressBridgeEnabled();
  const suppressed = isSuppressedLocation(pathname, search);
  // `key` alone is `address:token` — stable across balances. Folding the balance
  // in makes the guard once-per-balance-value, matching the store watermark.
  const arrivalKey = pendingDrawer ? `${pendingDrawer.key}:${pendingDrawer.balance.toString()}` : null;

  useEffect(() => {
    if (!enabled || suppressed || !pendingDrawer || arrivalKey === null) return;
    if (shownKeyRef.current === arrivalKey) return;
    shownKeyRef.current = arrivalKey;
    setArrival(pendingDrawer);
    void markDrawerShown(pendingDrawer.token);
  }, [enabled, suppressed, arrivalKey, pendingDrawer, markDrawerShown]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setArrival(null);
  }, []);

  const handleLater = useCallback(() => setArrival(null), []);

  // Navigate to the Cross-chain tab with the bridge sheet pre-armed for the
  // arrived token (WS2/WS3 consume `bridge=1` + `token`).
  const handleBridge = useCallback(() => {
    if (!arrival) return;
    const { token } = arrival;
    setArrival(null);
    navigate(`/receive?tab=crosschain&bridge=1&token=${token}`);
  }, [arrival]);

  if (!enabled || suppressed || !arrival) return null;

  const config = getDepositToken(arrival.token);
  const amount = formatBalance(arrival.amount, config.decimals);

  return (
    <Drawer open onOpenChange={handleOpenChange}>
      <DrawerContent className="md:mx-auto md:max-w-md">
        <DrawerHeader>
          <DrawerTitle>{t('depositArrivalDrawerTitle', { amount, symbol: config.symbol })}</DrawerTitle>
        </DrawerHeader>

        <div data-testid="deposit-arrival-drawer" className="flex flex-col items-center gap-3 px-4 pb-2">
          <TokenLogo symbol={config.symbol} size="lg" />
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-heading-gray">
            {t('ethereumSepolia')}
          </span>
          <p className="text-center text-sm text-text-muted">{t('depositArrivalDrawerDescription')}</p>
        </div>

        <div className="mt-auto flex flex-col items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button
            variant={ButtonVariant.Primary}
            title={t('bridgeToMiden')}
            onClick={handleBridge}
            data-testid="deposit-arrival-bridge"
          />
          <Button
            variant={ButtonVariant.Ghost}
            title={t('depositArrivalLater')}
            onClick={handleLater}
            data-testid="deposit-arrival-later"
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default DepositArrivalDrawer;
