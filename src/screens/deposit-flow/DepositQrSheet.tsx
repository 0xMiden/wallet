import React from 'react';

import { useTranslation } from 'react-i18next';

import { QRCode } from 'components/QRCode';
import { cn } from 'lib/ui/util';

import { DepositSheet } from './parts';
import * as s from './styles';

/** Resolution of the QR image; on screen the code fills its card. */
const QR_SIZE = 300;

export interface DepositQrSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the QR code carries, as it is (an address or a payment URI). */
  value: string;
  /** The line under the code. Defaults to "Scan with the wallet on your other device." */
  note?: string;
}

/** The "Scan to send" sheet (mock-up `sheet === 'qr'`): the real QR code of `value` and a note. */
export const DepositQrSheet: React.FC<DepositQrSheetProps> = ({ open, onOpenChange, value, note }) => {
  const { t } = useTranslation();
  return (
    <DepositSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('depositFlowScanToSend')}
      screenKey="deposit-qr"
      data-testid="deposit-qr-sheet"
    >
      <div className={s.QRCARD} data-testid="deposit-qr-sheet-code">
        <QRCode address={value} payload="plain" size={QR_SIZE} palette="blue" />
      </div>
      <p className={cn(s.NOTE, 'text-center')}>{note ?? t('depositFlowScanNote')}</p>
    </DepositSheet>
  );
};
