import React from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';
import { truncateAddress } from 'utils/string';

import { SendFlowAction } from './types';

export interface ReviewTransactionProps {
  amount: string;
  token: string;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onSubmit: () => void;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recipientAddress?: string;
  recallBlocks?: string;
  recallDate?: Date;
  recallTime: string;
}

export const ReviewTransaction: React.FC<ReviewTransactionProps> = ({
  amount,
  token,
  recipientAddress,
  sharePrivately,
  delegateTransaction,
  recallBlocks,
  recallDate,
  recallTime,
  onGoBack,
  onSubmit
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();

  const displayRecalLabel = recallDate ? `${format(recallDate, 'MMM d, yyyy')} ${recallTime}` : t('selectRecallDate');

  const hasRecall = !!recallBlocks && parseInt(recallBlocks) > 0;

  return (
    <div className="flex flex-col bg-white h-full">
      <NavigationHeader mode="back" title={t('reviewTransaction')} onBack={onGoBack} showBorder />

      <div className="flex flex-col px-4 overflow-y-auto no-scrollbar">
        {/* Amount */}
        <div className="flex items-center justify-center pt-8">
          <span className="text-[48px] font-medium text-heading-gray/53 leading-none">
            {amount} {token}
          </span>
        </div>

        {/* Transfer Details Card */}
        <div className="mt-8 border border-[#E6E6E6] rounded-2xl w-full">
          <div className="text-xs border-b border-[#E6E6E6] font-semibold text-heading-gray uppercase tracking-[0.6px] leading-4 w-full py-3 pl-4">
            {t('transferDetails')}
          </div>

          <DetailRow label={t('from')} value={truncateAddress(publicKey)} />
          <DetailRow label={t('to')} value={truncateAddress(recipientAddress || '')} />
          <DetailRow label={t('network')} badge={t('testnet')} isLast={!hasRecall} />
          {hasRecall && <DetailRow label={t('recallBy')} value={displayRecalLabel || recallBlocks!} isLast />}
        </div>

        {/* Options Card */}
        <div className="mt-4 border border-[#E6E6E6] rounded-2xl">
          <div className="text-xs border-b border-[#E6E6E6] font-semibold text-heading-gray uppercase tracking-[0.6px] leading-4 w-full py-3 pl-4">
            {t('options')}
          </div>
          <OptionRow icon={IconName.Lock} label={t('privatePayment')} enabled={sharePrivately} />
          <OptionRow
            icon={IconName.DelegateProving}
            label={t('delegateProving')}
            enabled={delegateTransaction}
            isLast={!hasRecall}
          />
          {hasRecall && <OptionRow icon={IconName.RecallClock} label={t('recallEnabled')} enabled={true} isLast />}
        </div>

        <div className="flex-1" />

        {/* Buttons */}
        <div className="pt-12 pb-4 flex flex-col gap-y-4">
          <Button
            type="submit"
            title={t('confirm')}
            variant={ButtonVariant.Primary}
            onClick={onSubmit}
            className="w-full rounded-5 text-base font-semibold"
          />
          <Button
            type="button"
            onClick={onGoBack}
            variant={ButtonVariant.Secondary}
            className="w-full rounded-5 bg-gray-25"
            title={t('cancel')}
          />
        </div>
      </div>
    </div>
  );
};

const DetailRow = ({
  label,
  value,
  badge,
  isLast
}: {
  label: string;
  value?: string;
  badge?: string;
  isLast?: boolean;
}) => (
  <div className={`flex items-center justify-between px-4 py-3 ${!isLast ? 'border-b border-[#E6E6E6]' : ''}`}>
    <span className="text-sm text-heading-gray">{label}</span>
    {badge ? (
      <span className="text-sm font-medium text-[#CC5200] bg-[#FFF3EB] px-3 py-1 rounded-full">{badge}</span>
    ) : (
      <span className="text-sm text-heading-gray font-medium">{value}</span>
    )}
  </div>
);

const OptionRow = ({
  icon,
  label,
  enabled,
  isLast
}: {
  icon: IconName;
  label: string;
  enabled: boolean;
  isLast?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center justify-between px-4 py-3 ${!isLast ? 'border-b border-[#E6E6E6]' : ''}`}>
      <div className="flex items-center gap-3">
        <Icon name={icon} size="xs" />
        <span className="text-sm text-heading-gray">{label}</span>
      </div>
      <span
        className={`text-xs font-medium px-3 py-1 rounded-full ${
          enabled ? 'text-[#CC5200] bg-[#FFF3EB]' : 'text-heading-gray/60 bg-[#F2F2F2]'
        }`}
      >
        {enabled ? t('on') : t('off')}
      </span>
    </div>
  );
};
