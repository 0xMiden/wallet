import React from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { useAccount } from 'lib/miden/front';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
import { truncateAddress } from 'utils/string';

import { BridgeRoute } from './BridgeOptions';
import { SendFlowAction } from './types';

export interface ReviewTransactionProps {
  amount: string;
  token: string;
  fiatValue: number;
  onAction: (action: SendFlowAction) => void;
  onGoBack: () => void;
  onClose: () => void;
  onSubmit: () => void;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recipientAddress?: string;
  recipientChain?: 'miden' | 'ethereum';
  bridgeRoute?: BridgeRoute;
  recallBlocks?: string;
  recallDate?: Date;
  recallTime: string;
}

export const ReviewTransaction: React.FC<ReviewTransactionProps> = ({
  amount,
  token,
  fiatValue,
  recipientAddress,
  recipientChain,
  bridgeRoute,
  sharePrivately,
  delegateTransaction,
  recallBlocks,
  recallDate,
  recallTime,
  onGoBack,
  onClose,
  onSubmit
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();

  const isBridge = recipientChain === 'ethereum';
  const route: BridgeRoute = bridgeRoute ?? 'epoch';
  const displayRecallLabel = recallDate ? `${format(recallDate, 'MMM d, yyyy')} ${recallTime}` : t('selectRecallDate');
  const hasRecall = !isBridge && !!recallBlocks && parseInt(recallBlocks) > 0;

  return (
    <div className="flex flex-col bg-app-bg h-full px-4">
      <ScreenHeader title={t('reviewDetails')} closeLabel={t('close')} onClose={onClose} />

      <div className="flex flex-col flex-1 min-h-0 ">
        <div className="flex-1 overflow-y-auto no-scrollbar">
          {/* Amount */}
          <div className="flex flex-col items-center gap-1 py-6 border-b border-border-faint">
            <span className="text-5xl font-extrabold leading-none text-heading-gray">
              {amount} {token}
            </span>
            <span className="text-sm  text-[#8E8E93]">
              {t('approxFiatValue', { value: `$${fiatValue.toFixed(2)}` })}
            </span>
          </div>

          {/* Transfer details */}
          <h4 className="text-sm font-semibold text-heading-gray mt-6 mb-2">{t('transferDetails')}</h4>
          <DetailCard>
            <DetailRow label={t('from')} value={truncateAddress(publicKey)} />
            <DetailRow label={t('to')} value={truncateAddress(recipientAddress || '')} isLast={!hasRecall} />
            {hasRecall && <DetailRow label={t('recallBy')} value={displayRecallLabel} isLast />}
          </DetailCard>

          {isBridge ? (
            <>
              {/* Bridge details */}
              <h4 className="text-sm font-semibold text-heading-gray mt-6 mb-2">{t('bridgeDetails')}</h4>
              <DetailCard>
                <DetailRow label={t('route')} value={route === 'epoch' ? t('fastRouteLabel') : t('slowRouteLabel')} />
                <DetailRow label={t('destinationNetwork')} value="Sepolia" isLast />
              </DetailCard>
            </>
          ) : (
            <>
              {/* Advanced details */}
              <h4 className="text-sm font-semibold text-heading-gray mt-6 mb-2">{t('advancedDetails')}</h4>
              <DetailCard>
                <DetailRow label={t('privatePayment')}>
                  <StatusText enabled={sharePrivately} />
                </DetailRow>
                <DetailRow label={t('delegateProving')} isLast={!hasRecall}>
                  <StatusText enabled={delegateTransaction} />
                </DetailRow>
                {hasRecall && (
                  <DetailRow label={t('recallEnabled')} isLast>
                    <StatusText enabled />
                  </DetailRow>
                )}
              </DetailCard>
            </>
          )}
        </div>

        <div className="shrink-0 pt-6 pb-4 flex flex-col gap-y-2">
          <Button type="submit" title={t('sendPayment')} variant={ButtonVariant.Primary} onClick={onSubmit} />
          <Button type="button" onClick={onGoBack} variant={ButtonVariant.Secondary} title={t('back')} />
        </div>
      </div>
    </div>
  );
};

const StatusText: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t } = useTranslation();
  return (
    <span className={`text-sm font-medium ${enabled ? 'text-[#CC5200]' : 'text-heading-gray/60'}`}>
      {enabled ? t('on') : t('off')}
    </span>
  );
};
