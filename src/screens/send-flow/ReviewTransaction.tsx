import React from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
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
    <div className="flex flex-col bg-app-bg h-full">
      <NavigationHeader mode="back" title={t('reviewTransaction')} onBack={onGoBack} showBorder />

      <div className="flex flex-col px-4 overflow-y-auto no-scrollbar">
        {/* Amount */}
        <div className="flex items-center justify-center pt-8">
          <span className="text-[48px] font-medium text-heading-gray/53 leading-none">
            {amount} {token}
          </span>
        </div>

        {/* Transfer Details Card */}
        <div className="mt-8 w-full">
          <DetailCard title={t('transferDetails')}>
            <DetailRow label={t('from')} value={truncateAddress(publicKey)} />
            <DetailRow label={t('to')} value={truncateAddress(recipientAddress || '')} />
            <DetailRow label={t('network')} badge={t('testnet')} isLast={!hasRecall} />
            {hasRecall && <DetailRow label={t('recallBy')} value={displayRecalLabel || recallBlocks!} isLast />}
          </DetailCard>
        </div>

        {/* Options Card */}
        <div className="mt-4">
          <DetailCard title={t('options')}>
            <DetailRow
              label={t('privatePayment')}
              icon={<Icon name={IconName.Lock} size="xs" className="text-primary-500" />}
            >
              <ToggleBadge enabled={sharePrivately} />
            </DetailRow>
            <DetailRow
              label={t('delegateProving')}
              icon={<Icon name={IconName.DelegateProving} size="xs" className="text-primary-500" />}
              isLast={!hasRecall}
            >
              <ToggleBadge enabled={delegateTransaction} />
            </DetailRow>
            {hasRecall && (
              <DetailRow
                label={t('recallEnabled')}
                icon={<Icon name={IconName.RecallClock} size="xs" className="text-primary-500" />}
                isLast
              >
                <ToggleBadge enabled />
              </DetailRow>
            )}
          </DetailCard>
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

const ToggleBadge: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t } = useTranslation();
  return (
    <span
      className={`text-xs font-medium px-3 py-1 rounded-full ${
        enabled ? 'text-[#CC5200] bg-[#FFF3EB]' : 'text-heading-gray/60 bg-[#F2F2F2]'
      }`}
    >
      {enabled ? t('on') : t('off')}
    </span>
  );
};
