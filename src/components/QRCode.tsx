import React, { useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';
import { QRCode as QRCodeSvg } from 'react-qr-svg';

import { hapticLight } from 'lib/mobile/haptics';
import { encodeAddress } from 'lib/qr/format';
import { truncateAddress } from 'utils/string';

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /** Size of the QR code in pixels */
  size?: number;
  /** Called when the QR code block is clicked */
  onCopy?: () => void;
  /** Additional CSS classes for the container */
  className?: string;
}

/**
 * QR code display component for Miden addresses.
 * Displays a QR code encoding the address in miden:<address> format.
 * The entire block is clickable to copy the address to clipboard.
 */
export const QRCode: React.FC<QRCodeProps> = ({ address, size = 80, onCopy, className }) => {
  const { t } = useTranslation();

  const handleClick = useCallback(() => {
    hapticLight();
    navigator.clipboard.writeText(address);
    onCopy?.();
  }, [address, onCopy]);

  const qrValue = encodeAddress(address);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={classNames(
        'flex flex-col items-center justify-center gap-y-2 p-3',
        'rounded-lg bg-grey-50',
        'cursor-pointer hover:bg-grey-100 transition duration-300 ease-in-out',
        'focus:outline-none focus:ring-2 focus:ring-primary-500',
        className
      )}
      aria-label={t('copyToClipboard')}
    >
      <div className="bg-pure-white p-2 rounded-md">
        <QRCodeSvg
          value={qrValue}
          style={{ width: size, height: size }}
          bgColor="#FFFFFF"
          fgColor="#000000"
          level="M"
        />
      </div>
      <span className="text-sm text-grey-600 font-mono truncate max-w-full">
        {truncateAddress(address, true, 8, 4, 8)}
      </span>
    </button>
  );
};

export default QRCode;
