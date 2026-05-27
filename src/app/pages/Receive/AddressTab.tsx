import React, { useCallback } from 'react';

import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { QRCode } from 'components/QRCode';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

interface AddressTabProps {
  address: string;
}

export const AddressTab: React.FC<AddressTabProps> = ({ address }) => {
  const { t } = useTranslation();
  const { fieldRef, copy, copied } = useCopyToClipboard();

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
        <div className="m-auto flex flex-col items-center px-13 pt-8 pb-32 gap-8">
          <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
          <div className="flex items-center justify-center">
            <QRCode address={address} size={240} onCopy={copy} className="w-auto" />
          </div>
          <div className="flex items-center gap-12">
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
        </div>
      </div>
    </div>
  );
};
