import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { Card } from 'components/ui/Card';

interface EvmBridgeDepositConfirmProps {
  amount: string;
  tokenSymbol: string;
  midenAccountName: string;
  routeLabel: string;
  receiveLabel: string | null;
  statusMessage: string | null;
  error: string | null;
  confirmLabel: string;
  confirmDisabled: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

export const EvmBridgeDepositConfirm: React.FC<EvmBridgeDepositConfirmProps> = ({
  amount,
  tokenSymbol,
  midenAccountName,
  routeLabel,
  receiveLabel,
  statusMessage,
  error,
  confirmLabel,
  confirmDisabled,
  onBack,
  onClose,
  onConfirm
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg text-ink">
      <div className="shrink-0 px-4">
        <PageHeader title={t('bridgeDepositTitle')} onBack={onBack} onClose={onClose} />
      </div>

      <div className="flex flex-1 min-h-0 flex-col px-4 pt-4">
        <div className="flex-1 overflow-y-auto">
          <div className="text-center">
            <h2 className="text-[28px] font-semibold leading-tight text-ink">{t('bridgeDepositHeading')}</h2>
            <p className="text-sm text-text-tertiary-token">{t('bridgeDepositSubheading')}</p>
          </div>

          <Card padding="row" className="mt-4">
            <ConfirmRow label={t('amount')} value={`${amount || '0'} ${tokenSymbol}`} />
            {receiveLabel && <ConfirmRow label={t('bridgeDepositYouReceive')} value={receiveLabel} />}
            <ConfirmRow label={t('from')} value="Sepolia" />
            <ConfirmRow label={t('to')} value={`Miden · ${midenAccountName}`} />
            <ConfirmRow label={t('bridgeDepositBridgeOption')} value={routeLabel} isLast />
          </Card>

          <div className="mt-5 rounded-2xl bg-fill px-6 py-4 text-[#5A3F0A]">
            <p className="text-xs font-bold uppercase tracking-[0.12em]">{t('bridgeDepositApprovingTitle')}</p>
            <p className="mt-2 text-xs leading-none">{t('bridgeDepositApprovingBody', { tokenSymbol })}</p>
          </div>

          {statusMessage && <p className="mt-4 text-center text-sm text-text-tertiary-token">{statusMessage}</p>}
          {error && (
            <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="pt-4">
          <Button variant={ButtonVariant.Primary} onClick={onConfirm} disabled={confirmDisabled} className="w-full">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

interface ConfirmRowProps {
  label: string;
  value: string;
  isLast?: boolean;
}

const ConfirmRow: React.FC<ConfirmRowProps> = ({ label, value, isLast }) => (
  <div className={`flex items-center justify-between py-2.5 ${isLast ? '' : 'border-b border-border-faint'}`}>
    <span className="min-w-0 text-xs text-text-tertiary-token">{label}</span>
    <span className="min-w-0 truncate text-right text-xs font-semibold text-ink">{value}</span>
  </div>
);
