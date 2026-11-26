import { useEffect, useState } from 'react';

import { App } from '@capacitor/app';

import { availablePaymentWallets } from 'lib/mobile/wallet-payments';
import type { PaymentWalletId, WalletPaymentLink } from 'lib/one-click/payment-links';
import { isMobile } from 'lib/platform';

/**
 * The payment wallets installed on this phone. It reads them again each time the app comes back to the foreground, so
 * a wallet the user installs in the meantime shows. Empty off mobile.
 */
export function useInstalledPaymentWallets(): PaymentWalletId[] {
  const [installed, setInstalled] = useState<PaymentWalletId[]>([]);
  useEffect(() => {
    if (!isMobile()) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const wallets = await availablePaymentWallets();
        if (active) setInstalled(wallets);
      } catch {
        if (active) setInstalled([]);
      }
    };
    refresh();
    const listener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) refresh();
    }).catch(() => undefined);
    return () => {
      active = false;
      listener.then(handle => handle?.remove()).catch(() => {});
    };
  }, []);
  return installed;
}

/**
 * The links that the "Open wallet" sheet offers: only wallets that are installed, and Phantom only when Trust Wallet is
 * not installed (both take a Solana link; Trust Wallet takes the others too).
 */
export function installedPaymentLinks(
  links: readonly WalletPaymentLink[],
  installed: readonly PaymentWalletId[]
): WalletPaymentLink[] {
  return links.filter(
    link => installed.includes(link.wallet) && (link.wallet !== 'phantom' || !installed.includes('trust'))
  );
}
