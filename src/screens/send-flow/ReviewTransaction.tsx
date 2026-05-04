import React from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import { useAccount } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
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

  // On mobile, the Confirm CTA is hoisted into the always-on native navbar
  // (compact mode morph). Cancel is dropped on mobile — the back arrow in
  // NavigationHeader provides the same affordance, per design direction.
  useNativeNavbarAction({
    label: t('confirm'),
    onTap: onSubmit,
    enabled: true
  });

  return (
    <div className="flex flex-col bg-app-bg h-full">
      <NavigationHeader mode="back" title={t('reviewTransaction')} onBack={onGoBack} showBorder />

      <div className="flex flex-col flex-1 min-h-0 px-4">
        <div className="flex-1 overflow-y-auto no-scrollbar">
          {/* Amount */}
          <div className="flex items-center justify-center py-4">
            <span className="text-3xl font-medium text-heading-gray/53 leading-none">
              {amount} {token}
            </span>
          </div>

          {/* Transfer Details Card */}
          <DetailCard>
            <DetailRow label={t('from')} value={truncateAddress(publicKey)} />
            <DetailRow label={t('to')} value={truncateAddress(recipientAddress || '')} />
            <DetailRow label={t('network')} badge={t('testnet')} isLast={!hasRecall} />
            {hasRecall && <DetailRow label={t('recallBy')} value={displayRecalLabel || recallBlocks!} isLast />}
          </DetailCard>

          {/* Options Card */}
          <div className="mt-3">
            <DetailCard>
              <DetailRow label={t('privatePayment')}>
                <ToggleBadge enabled={sharePrivately} />
              </DetailRow>
              <DetailRow label={t('delegateProving')} isLast={!hasRecall}>
                <ToggleBadge enabled={delegateTransaction} />
              </DetailRow>
              {hasRecall && (
                <DetailRow label={t('recallEnabled')} isLast>
                  <ToggleBadge enabled />
                </DetailRow>
              )}
            </DetailCard>
          </div>
        </div>

        {/* Buttons — hidden on mobile (Confirm is hoisted to the native
            navbar; Cancel is dropped because back-arrow in the header
            already provides the affordance). */}
        {!isMobile() && (
          <div className="shrink-0 pt-4 pb-4 flex flex-col gap-y-2">
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
              className="w-full rounded-5"
              title={t('cancel')}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const ToggleBadge: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t } = useTranslation();
  // The disabled state previously used literal text-heading-gray/60 on bg-[#F2F2F2]
  // — text-heading-gray flips to white in dark mode, so white-on-light-grey
  // hid the "Off" label. text-text-muted + bg-input-bg both auto-flip and
  // keep adequate contrast on both themes.
  return (
    <span
      className={`text-xs font-medium px-3 py-1 rounded-full ${
        enabled ? 'text-[#CC5200] bg-[#FFF3EB]' : 'text-text-muted bg-input-bg'
      }`}
    >
      {enabled ? t('on') : t('off')}
    </span>
  );
};
