import { useCallback, useRef } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import type { QRCodeHandle } from 'components/QRCode';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

interface UseShareAddressArgs {
  /** Address shared as plain text alongside the rendered QR image. */
  address: string;
  /** File name given to the shared PNG (mobile cache file / Web Share `File`). */
  fileName: string;
  /** Called when no share sheet is available or the user dismissed it. */
  onFallbackCopy: () => void;
}

interface UseShareAddressResult {
  /** Attach to the `<QRCode>` whose image should ride along with the share. */
  qrRef: React.RefObject<QRCodeHandle>;
  share: () => Promise<void>;
}

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

/**
 * Shares an address plus its rendered QR image: native share sheet on mobile
 * (Capacitor Filesystem + Share), Web Share API elsewhere, clipboard copy as
 * the last resort. Extracted from AddressTab so the cross-chain tab can share
 * its EVM deposit address the same way.
 */
export function useShareAddress({ address, fileName, onFallbackCopy }: UseShareAddressArgs): UseShareAddressResult {
  const { t } = useTranslation();
  const qrRef = useRef<QRCodeHandle>(null);

  const share = useCallback(async () => {
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
            path: fileName,
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
          const file = new File([qrBlob], fileName, { type: 'image/png' });
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
    onFallbackCopy();
  }, [address, fileName, onFallbackCopy, t]);

  return { qrRef, share };
}
