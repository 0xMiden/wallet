import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { goBack, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { EarnAmountUnit, EarnAssetMark, EarnHero, earnSubjectTitle } from './components';
import { placeholderPosition } from './earn-mapping';
import { useEarnPositions } from './useEarnPositions';

interface EarnWithdrawReviewProps {
  positionId: string;
}

/**
 * Smart Withdraw review — mirrors `EarnDepositReview`. Withdrawals are always
 * the FULL withdrawable amount (no partial-amount input exists), so the hero is
 * read-only. Confirm creates the tracking row and hands off to the
 * generating-transaction screen via `onRowCreated`; the intent work continues
 * behind it and flips the row's phase, which that screen observes.
 */
const EarnWithdrawReview: FC<EarnWithdrawReviewProps> = ({ positionId }) => {
  const { t } = useTranslation();
  const { positions } = useEarnPositions();
  const position = useMemo(
    () => positions.find(item => item.id === positionId) ?? placeholderPosition(),
    [positions, positionId]
  );
  const account = useAccount();
  const withdrawSymbol = 'USDC';
  const amountValue = Number(position.withdrawable) || 0;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // `Button` fires the tap haptic itself; calling it here too would buzz twice.
  const handleWithdraw = async () => {
    if (isSubmitting) return;
    if (!account.evmAddress || account.evmAddress.toLowerCase() !== position.owner.toLowerCase()) {
      setSubmitError(t('earnWithdrawNotOwned'));
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await gaslessEarnWithdrawalToMiden({
        midenAccountPublicKey: account.publicKey,
        evmAddress: account.evmAddress,
        marketUid: position.marketUid,
        underlyingAddress: position.underlyingAddress,
        amount: position.withdrawable,
        underlyingDecimals: position.decimals,
        // No Miden-side transaction happens (gasless EVM intent sign), so the
        // handoff goes to the bespoke withdraw status screen — not the
        // prove/submit generating-transaction page.
        onRowCreated: txId => navigate(`/earn/withdraw-status/${encodeURIComponent(txId)}`)
      });
    } catch (e) {
      // If the row was already created we have navigated away and the
      // generating screen renders the failed phase; this only surfaces
      // pre-row validation errors.
      setSubmitError(e instanceof Error ? e.message : t('earnGaslessWithdrawalFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    // The shared pushed-page frame, so this review and the deposit review are one page shape.
    <SubPageLayout
      data-testid="earn-withdraw-review-page"
      title={earnSubjectTitle(position)}
      onBack={goBack}
      headerActions={<EarnAssetMark asset={position.asset} network={position.network} />}
      footerLayout="stack"
      footer={
        <>
          {submitError && (
            <Notice tone="negative" role="alert" data-testid="earn-withdraw-review-error">
              {submitError}
            </Notice>
          )}
          <Button
            data-testid="earn-withdraw-review-confirm"
            title={isSubmitting ? t('withdrawing') : t('withdraw')}
            variant={ButtonVariant.Primary}
            accent="earn"
            onClick={handleWithdraw}
            disabled={isSubmitting || amountValue <= 0 || !position.id}
            className="w-full max-w-none"
          />
        </>
      }
    >
      <EarnHero
        labelId="earn-withdraw-review-amount"
        value={toAdaptiveFixed(amountValue)}
        unit={<EarnAmountUnit symbol={withdrawSymbol} />}
        label={t('earnWithdrawAmount')}
      />

      {/* The shared detail card: one `fill` block of label/value rows, hairlines between
          them, as on every other review in the app. */}
      <DetailCard>
        <DetailRow label={t('route')}>{`${position.protocol} (${position.network}) -> Miden`}</DetailRow>
        <DetailRow label={t('positionOwnerLabel')}>{truncateAddress(position.owner, false, 8, 8)}</DetailRow>
        <DetailRow label={t('earnWithdrawalLabel')}>{t('earnFullPositionGasless')}</DetailRow>
        <DetailRow label={t('earnEstimatedTimeLabel')}>{t('earnEstimatedTimeOneMinute')}</DetailRow>
      </DetailCard>
    </SubPageLayout>
  );
};

export default EarnWithdrawReview;
