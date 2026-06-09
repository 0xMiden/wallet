import React, { useCallback, useEffect, useState } from 'react';

import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { QRCode } from 'components/QRCode';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { Button } from 'lib/ui/button';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { navigate } from 'lib/woozie';

interface AddressTabProps {
  address: string;
}

export const AddressTab: React.FC<AddressTabProps> = ({ address }) => {
  const { t } = useTranslation();
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const [evmOpen, setEvmOpen] = useState(false);
  const { address: evmAddress, connected: evmConnected } = useEvmWalletConnection();

  const openBridgeDeposit = useCallback(() => {
    navigate('/bridge/deposit');
  }, []);

  const handleOpenEvm = useCallback(() => {
    hapticLight();
    if (evmConnected && evmAddress) {
      openBridgeDeposit();
      return;
    }
    setEvmOpen(true);
  }, [evmAddress, evmConnected, openBridgeDeposit]);

  useEffect(() => {
    if (!evmOpen || !evmConnected || !evmAddress) return;
    setEvmOpen(false);
    openBridgeDeposit();
  }, [evmAddress, evmConnected, evmOpen, openBridgeDeposit]);

  const handleShare = useCallback(async () => {
    hapticLight();
    try {
      if (isMobile()) {
        await Share.share({ text: address, dialogTitle: t('receive') });
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ text: address });
        return;
      }
    } catch (e) {
      console.warn('[Receive] share dismissed:', e);
    }
    copy();
  }, [address, copy, t]);

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ touchAction: 'pan-y' }}
      data-testid="receive-page"
    >
      <div className="min-h-full flex flex-col">
        <div className="flex flex-col items-center px-6 pt-8 pb-32">
          <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
          <div className="flex flex-col items-center justify-center gap-8">
            <QRCode address={address} size={300} />
            <span className="w-full rounded-10 text-center text-sm text-heading-gray py-5 bg-surface-interactive">
              {truncateAddress(address, false, 16, 8)}
            </span>
          </div>
          <div className="flex items-center gap-12 pt-4 pb-4">
            <button
              type="button"
              onClick={handleShare}
              className="flex flex-col items-center gap-4 text-accent-primary"
            >
              <Icon name={IconName.Share} className="w-6 h-6" />
              <span className="text-base font-semibold text-heading-gray">{t('share')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                hapticLight();
                copy();
              }}
              className="flex flex-col items-center gap-4 text-accent-primary"
            >
              <Icon name={IconName.Copy} className="w-6 h-6 text-accent-primary" />
              <span className="text-base font-semibold text-heading-gray">{copied ? t('copied') : t('copy')}</span>
            </button>
          </div>
          <div className="w-full border-t border-rule-strong pt-4">
            <Button
              variant="outline"
              size="lg"
              onClick={handleOpenEvm}
              className="h-14 w-full rounded-xl border-border-button bg-white text-base font-semibold text-heading-gray hover:bg-white"
            >
              {t('receiveFromEvm')}
            </Button>
          </div>
        </div>
      </div>
      <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />
    </div>
  );
};
