import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import CopyButton from 'app/atoms/CopyButton';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { QRCode, type QRCodeHandle } from 'components/QRCode';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

interface AddressTabProps {
  address: string;
}

const QR_FILE_NAME = 'miden-address.png';

/** Reads a Blob as raw base64 (without the `data:*;base64,` prefix) for Capacitor Filesystem. */
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result.slice(result.indexOf(',') + 1));
      } else {
        reject(new Error('Unexpected FileReader result'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read QR image'));
    reader.readAsDataURL(blob);
  });

export const AddressTab: React.FC<AddressTabProps> = ({ address }) => {
  const { t } = useTranslation();
  const { fieldRef, copy } = useCopyToClipboard();
  const [evmOpen, setEvmOpen] = useState(false);
  const { address: evmAddress, connected: evmConnected } = useEvmWalletConnection();
  const qrRef = useRef<QRCodeHandle>(null);

  const handleOpenEvm = useCallback(() => {
    hapticLight();
    if (evmConnected && evmAddress) {
      navigate('/bridge/deposit');
      return;
    }
    setEvmOpen(true);
  }, [evmAddress, evmConnected]);

  useEffect(() => {
    if (!evmOpen || !evmConnected || !evmAddress) return;
    setEvmOpen(false);
    navigate('/bridge/deposit');
  }, [evmAddress, evmConnected, evmOpen]);

  const handleShare = useCallback(async () => {
    hapticLight();

    let qrBlob: Blob | null = null;
    try {
      qrBlob = (await qrRef.current?.getImageBlob()) ?? null;
    } catch (e) {
      console.warn('[Receive] failed to render QR image for share:', e);
    }

    try {
      if (isMobile()) {
        if (qrBlob) {
          const { uri } = await Filesystem.writeFile({
            path: QR_FILE_NAME,
            data: await blobToBase64(qrBlob),
            directory: Directory.Cache
          });
          await Share.share({ text: address, files: [uri], dialogTitle: t('receive') });
        } else {
          await Share.share({ text: address, dialogTitle: t('receive') });
        }
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.share) {
        if (qrBlob && typeof navigator.canShare === 'function') {
          const file = new File([qrBlob], QR_FILE_NAME, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text: address });
            return;
          }
        }
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
              className="w-full rounded-full! text-center py-5 bg-surface-interactive hover:bg-surface-interactive"
            >
              <span className="text-base font-heading font-bold text-heading-gray">
                {truncateAddress(address, false, 16, 8)}
              </span>
            </CopyButton>
          </div>
          <div className="w-full flex flex-col items-center gap-8 pt-6">
            <button type="button" onClick={handleShare} className="flex items-center gap-4 text-accent-primary">
              <Icon name={IconName.Share} size="lg" className="shrink-0" />
              <span className="font-heading text-[2.5rem] font-bold leading-none text-heading-gray">{t('share')}</span>
            </button>
            {/* <div className="flex items-center gap-4 text-accent-primary">
              <Icon name={IconName.Add} size="lg" className="shrink-0 fill-current" />
              <span className="font-heading text-[2.5rem] font-bold leading-none text-heading-gray">Request</span>
            </div> */}
            <div className="flex items-center gap-4 text-accent-primary" onClick={handleOpenEvm}>
              <Icon name={IconName.CrossChain} size="lg" className="shrink-0" />
              <span className="font-heading text-[2.5rem] font-bold leading-none text-heading-gray">Cross-chain</span>
            </div>
          </div>
        </div>
      </div>
      <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />
    </div>
  );
};
