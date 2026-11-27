import React, { useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { Avatar } from 'components/ui/Avatar';
import { Spinner } from 'components/ui/Spinner';
import { hapticLight } from 'lib/mobile/haptics';
import type { PaymentWalletId, WalletPaymentLink } from 'lib/one-click/payment-links';
import { cn } from 'lib/ui/util';

import { DepositNotice, DepositSheet } from './parts';
import * as s from './styles';
import { PAYMENT_WALLET_DISPLAY } from './wallet-display';

export interface OpenWalletSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One row for each link, in this order. */
  links: readonly WalletPaymentLink[];
  /**
   * Opens a link in its wallet. It resolves true when the wallet opened. On mobile the caller uses
   * `openWalletPayment` (`lib/mobile/wallet-payments`), as the NEAR Intents deposit page does.
   */
  onOpenWallet: (link: WalletPaymentLink) => Promise<boolean>;
}

/**
 * The "Open in" sheet (mock-up `sheet === 'openin'`): one row for each wallet that can take the
 * deposit with the address and amount filled in, then a note. A wallet that does not open shows the
 * same message as the NEAR Intents deposit page.
 */
export const OpenWalletSheet: React.FC<OpenWalletSheetProps> = ({ open, onOpenChange, links, onOpenWallet }) => {
  const { t } = useTranslation();
  const [opening, setOpening] = useState<PaymentWalletId>();
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  const openLink = async (link: WalletPaymentLink) => {
    if (busy.current) return;
    busy.current = true;
    hapticLight();
    setOpening(link.wallet);
    setFailed(false);
    try {
      setFailed(!(await onOpenWallet(link)));
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setOpening(undefined);
    }
  };

  return (
    <DepositSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('depositFlowOpenIn')}
      screenKey="deposit-open-wallet"
      data-testid="deposit-open-wallet-sheet"
    >
      <div className={cn(s.LGROUP, 'divide-y divide-hairline')}>
        {links.map(link => {
          const display = PAYMENT_WALLET_DISPLAY[link.wallet];
          return (
            <button
              key={link.wallet}
              type="button"
              disabled={opening !== undefined}
              aria-busy={opening === link.wallet || undefined}
              onClick={() => openLink(link)}
              className={s.LG}
              data-testid={`deposit-open-wallet-${link.wallet}`}
            >
              <Avatar image={display.image} size={40} />
              <span>{t(display.label)}</span>
              {opening === link.wallet ? (
                <Spinner size="sm" />
              ) : (
                <ChevronRightIcon aria-hidden="true" className={cn(s.ICON_20, 'stroke-current')} />
              )}
            </button>
          );
        })}
      </div>
      <p className={s.NOTE}>{t('depositFlowOpenInNote')}</p>
      {/* A wallet that did not open is a hint, not an error, as on the NEAR Intents deposit page (a warning there). */}
      {failed && (
        <DepositNotice kind="inline" role="status" data-testid="deposit-open-wallet-failed">
          {t('depositWalletOpenFailed')}
        </DepositNotice>
      )}
    </DepositSheet>
  );
};
