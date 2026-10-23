import React, { useEffect, useState } from 'react';

import BigNumber from 'bignumber.js';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { DetailCard, DetailDisclosure, DetailRow } from 'components/ui/DetailCard';
import type { WeeklyClaimReview } from 'lib/arcade/weekly-claim';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface GcClaimReviewDrawerProps {
  review: WeeklyClaimReview | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A read-only quote until the user confirms; the backend rechecks the bound quote on redemption. */
export const GcClaimReviewDrawer: React.FC<GcClaimReviewDrawerProps> = ({ review, busy, onConfirm, onCancel }) => {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (review === null) return;
    setDetailsOpen(false);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review]);
  const receive = review?.mode === 'receive';
  const reclaim = review?.mode === 'reclaim';
  const totalFees = review
    ? new BigNumber(review.requestFee)
        .plus(receive || reclaim ? 0 : review.issuerBudget)
        .plus(receive || reclaim ? 0 : review.receiptFeeBudget)
        .toFixed()
    : '0';
  const expiry = review ? Date.parse(review.expiresAt) : NaN;
  const expired = !Number.isFinite(expiry) || expiry <= now;
  const formatDate = (value: string, withTime = false) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t('arcadeDateUnavailable');
    return `${new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : {}),
      timeZone: 'UTC'
    }).format(date)} UTC`;
  };
  return (
    <Drawer
      open={review !== null}
      onOpenChange={open => {
        if (!open) onCancel();
      }}
      screenKey="gc-claim-review"
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>
            {t(receive ? 'arcadeReviewReceive' : reclaim ? 'arcadeReviewReclaim' : 'arcadeReviewClaim')}
          </DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>
          {t(receive ? 'arcadeReceiveExplanation' : reclaim ? 'arcadeReclaimSummary' : 'arcadeClaimSummary')}
        </DrawerDescription>
        {review && (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-6">
            <DetailCard>
              {!reclaim && <DetailRow label={t('arcadeClaimAllocation')}>{t('arcadeClaimAllocationAmount')}</DetailRow>}
              <DetailRow
                label={t(receive ? 'arcadeReceiveFee' : reclaim ? 'arcadeReclaimNetworkFee' : 'arcadeEstimatedFees')}
              >
                {`${totalFees} ${review.nativeSymbol}`}
              </DetailRow>
              {(receive || reclaim) && (
                <DetailRow label={t(receive ? 'arcadeReceiveRefund' : 'arcadeReclaimRecoverableBudget')}>
                  {`${receive ? review.nativeRefund : review.issuerBudget} ${review.nativeSymbol}`}
                </DetailRow>
              )}
              <DetailDisclosure title={t('details')} open={detailsOpen} onOpenChange={setDetailsOpen}>
                {!reclaim && !receive && (
                  <>
                    <DetailRow label={t('arcadeClaimRequestFee')}>
                      {`${review.requestFee} ${review.nativeSymbol}`}
                    </DetailRow>
                    <DetailRow label={t('arcadeClaimIssuerBudget')}>
                      {`${review.issuerBudget} ${review.nativeSymbol}`}
                    </DetailRow>
                    <DetailRow label={t('arcadeClaimReceiptFeeBudget')}>
                      {`${review.receiptFeeBudget} ${review.nativeSymbol}`}
                    </DetailRow>
                  </>
                )}
                <DetailRow label={t('arcadeClaimAllocationWeek')} stacked>
                  {formatDate(review.allocationWeekStart)}
                </DetailRow>
                <DetailRow label={t('arcadeClaimReviewExpires')} stacked>
                  {formatDate(review.expiresAt, true)}
                </DetailRow>
              </DetailDisclosure>
            </DetailCard>
            {expired && (
              <p className="text-body-sm text-muted" role="status">
                {t('arcadeClaimReviewExpired')}
              </p>
            )}
            <Button
              disabled={busy || expired}
              onClick={onConfirm}
              title={t(receive ? 'arcadeConfirmReceive' : reclaim ? 'arcadeConfirmReclaim' : 'arcadeConfirmClaim')}
            />
            <Button variant={ButtonVariant.Secondary} onClick={onCancel} title={t('arcadeCancelReview')} />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
};
