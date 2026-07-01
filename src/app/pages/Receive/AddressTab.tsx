import React, { useCallback, useRef } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { QRCode, type QRCodeHandle } from 'components/QRCode';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
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
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const qrRef = useRef<QRCodeHandle>(null);

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
        <div className="flex flex-col items-center px-6 pt-8 pb-32">
          <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
          {/* Hidden, untruncated address for E2E DOM fallback (visible address below is truncated). */}
          <span data-testid="receive-address-full" className="sr-only">
            {address}
          </span>
          <div className="flex flex-col items-center justify-center gap-8">
            <QRCode ref={qrRef} address={address} size={300} />
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
        </div>
      </div>
    </div>
  );
};
