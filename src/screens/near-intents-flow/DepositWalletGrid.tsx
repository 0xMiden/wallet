import React, { useEffect, useRef, useState } from 'react';

import { App } from '@capacitor/app';
import { useTranslation } from 'react-i18next';

import { Avatar } from 'components/ui/Avatar';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import type { IOneClickTrackingData } from 'lib/miden/db/types';
import { availablePaymentWallets, openWalletPayment } from 'lib/mobile/wallet-payments';
import { depositPaymentLinks, PaymentWalletId } from 'lib/one-click/payment-links';
import { isMobile } from 'lib/platform';

import { depositDeadlineMs } from './deposit-status';
import metamaskIcon from '../../assets/wallets/metamask.svg?url';
import phantomIcon from '../../assets/wallets/phantom.svg?url';
import rainbowIcon from '../../assets/wallets/rainbow.svg?url';
import trustIcon from '../../assets/wallets/trust.svg?url';

const WALLET_DISPLAY: Record<PaymentWalletId, { label: string; image: string }> = {
  trust: { label: 'paymentWalletTrust', image: trustIcon },
  metamask: { label: 'paymentWalletMetamask', image: metamaskIcon },
  rainbow: { label: 'paymentWalletRainbow', image: rainbowIcon },
  phantom: { label: 'paymentWalletPhantom', image: phantomIcon }
};

export const DepositWalletGrid: React.FC<{ tracking: IOneClickTrackingData }> = ({ tracking }) => {
  const { t } = useTranslation();
  const [installed, setInstalled] = useState<PaymentWalletId[]>([]);
  const [opening, setOpening] = useState<PaymentWalletId>();
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!isMobile()) return;
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

  const links = depositPaymentLinks(tracking).filter(
    link => installed.includes(link.wallet) && (link.wallet !== 'phantom' || !installed.includes('trust'))
  );
  if (!isMobile() || links.length === 0) return null;

  const pay = async (wallet: PaymentWalletId) => {
    if (busy.current) return;
    // Check the deadline again. The app can return from the background before the countdown updates.
    const link = depositPaymentLinks(tracking).find(candidate => candidate.wallet === wallet);
    if (!link) return;
    busy.current = true;
    setOpening(wallet);
    setFailed(false);
    try {
      setFailed(!(await openWalletPayment(link, depositDeadlineMs(tracking))));
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setOpening(undefined);
    }
  };

  return (
    <section className="w-full" data-testid="deposit-wallet-grid" aria-label={t('depositPayDirectlyFrom')}>
      <SectionHeader>{t('depositPayDirectlyFrom')}</SectionHeader>
      <div className="grid grid-cols-2 gap-2">
        {links.map(({ wallet }) => (
          <Button
            key={wallet}
            variant={ButtonVariant.Secondary}
            size="tile"
            disabled={opening !== undefined}
            isLoading={opening === wallet}
            onClick={() => pay(wallet)}
            aria-label={t('depositPayWithWallet', { wallet: t(WALLET_DISPLAY[wallet].label) })}
            data-testid={`deposit-pay-${wallet}`}
          >
            <Avatar image={WALLET_DISPLAY[wallet].image} size={40} />
            <span>{t(WALLET_DISPLAY[wallet].label)}</span>
          </Button>
        ))}
      </div>
      {failed && (
        <Notice tone="warning" errorId={null} className="mt-2" data-testid="deposit-wallet-open-failed">
          {t('depositWalletOpenFailed')}
        </Notice>
      )}
    </section>
  );
};
