import React from 'react';

import { useTranslation } from 'react-i18next';

import CopyButton from 'app/atoms/CopyButton';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { useShareAddress } from 'app/pages/Receive/useShareAddress';
import { QRCode } from 'components/QRCode';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { truncateAddress } from 'utils/string';

interface AddressTabProps {
  address: string;
  /**
   * Legacy WalletConnect bridge entry, shown only when the Cross-chain tab is
   * unavailable (no derived EVM address) so those accounts keep a bridge path.
   */
  onCrossChain?: () => void;
}

const QR_FILE_NAME = 'miden-address.png';

export const AddressTab: React.FC<AddressTabProps> = ({ address, onCrossChain }) => {
  const { t } = useTranslation();
  const { fieldRef, copy } = useCopyToClipboard();
  const { qrRef, share } = useShareAddress({ address, fileName: QR_FILE_NAME, onFallbackCopy: copy });

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ touchAction: 'pan-y' }}
      data-testid="receive-page"
    >
      <div className="min-h-full flex flex-col">
        <div className="flex flex-col items-center px-6 pt-6 pb-32">
          <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
          {/* Hidden, untruncated address for E2E DOM fallback (visible address below is truncated). */}
          <span data-testid="receive-address-full" className="sr-only">
            {address}
          </span>
          <div className="w-full flex flex-col items-center justify-center gap-6">
            <QRCode ref={qrRef} address={address} size={300} />
            <CopyButton
              text={address}
              data-testid="receive-copy-address"
              className="w-full rounded-full! text-center py-5 bg-surface-interactive hover:bg-surface-interactive"
            >
              <span className="text-base font-heading font-bold text-heading-gray">
                {truncateAddress(address, false, 16, 8)}
              </span>
            </CopyButton>
          </div>
          <div className="w-full flex flex-col items-center gap-8 pt-6">
            <button type="button" onClick={share} className="flex items-center gap-4 text-accent-primary">
              <Icon name={IconName.Share} size="lg" className="shrink-0" />
              <span className="font-heading text-[2.5rem] font-bold leading-none text-heading-gray">{t('share')}</span>
            </button>
            {onCrossChain && (
              <button
                type="button"
                data-testid="receive-cross-chain"
                onClick={onCrossChain}
                className="flex items-center gap-4 text-accent-primary"
              >
                <Icon name={IconName.CrossChain} size="lg" className="shrink-0" />
                <span className="font-heading text-[2.5rem] font-bold leading-none text-heading-gray">
                  {t('crossChain')}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
