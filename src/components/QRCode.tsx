import React from 'react';

import { QRCode as QRCodeSvg } from 'react-qr-svg';

import { encodeAddress } from 'lib/qr/format';

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /** Size of the QR code in pixels */
  size: number;
}

/**
 * QR code display component for Miden addresses.
 * Displays a QR code encoding the address in miden:<address> format.
 * The entire block is clickable to copy the address to clipboard.
 */
export const QRCode: React.FC<QRCodeProps> = ({ address, size }) => {
  const qrValue = encodeAddress(address);

  return (
    <div className="bg-pure-white rounded-10 p-2">
      <QRCodeSvg value={qrValue} style={{ width: size, height: size }} bgColor="#FFFFFF" fgColor="#000000" level="M" />
    </div>
  );
};

export default QRCode;
