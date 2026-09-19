import React, { FC, useMemo, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { TokenLogo } from 'components/TokenLogo';
import { Pill } from 'components/ui/Pill';
import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { goBack, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

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

  const handleWithdraw = async () => {
    hapticLight();
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
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-withdraw-review-page">
      <PageHeader
        className="shrink-0 px-4"
        title={`${position.protocol} • ${position.asset}`}
        onBack={goBack}
        actions={
          <Pill className="shrink-0">
            {t('earnAssetOnNetwork', { asset: position.asset, network: position.network })}
          </Pill>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className={clsx('flex flex-col px-6 pt-6')}>
          <span className="font-heading text-2xl font-bold leading-none text-gray">{t('earnWithdrawAmount')}</span>
          <div className="mt-3 font-heading text-[4rem] font-bold leading-none text-ink">
            {toAdaptiveFixed(amountValue)}
          </div>
          <div className="flex items-center gap-1">
            <TokenLogo symbol={withdrawSymbol} size="md" />
            <span className="font-heading text-2xl font-bold text-ink">{withdrawSymbol}</span>
          </div>

          <div className="mt-8 space-y-6 pb-4">
            <DetailRow label={t('route')} value={`${position.protocol} (${position.network}) -> Miden`} />
            <DetailRow label={t('positionOwnerLabel')} value={truncateAddress(position.owner, false, 8, 8)} />
            <DetailRow label={t('earnWithdrawalLabel')} value={t('earnFullPositionGasless')} />
            <DetailRow label={t('earnEstimatedTimeLabel')} value={t('earnEstimatedTimeOneMinute')} />
          </div>
        </div>
      </div>

      <div className={clsx('shrink-0 pt-4 pb-6', isMobile() ? 'px-8' : 'px-6')}>
        {submitError && (
          <div className="mb-2 text-center text-sm leading-tight text-status-negative">{submitError}</div>
        )}
        <Button
          data-testid="earn-withdraw-review-confirm"
          title={isSubmitting ? t('withdrawing') : t('withdraw')}
          variant={ButtonVariant.Primary}
          onClick={handleWithdraw}
          disabled={isSubmitting || amountValue <= 0 || !position.id}
          className="w-full max-w-none"
        />
      </div>
    </div>
  );
};

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 text-sm leading-tight">
    <div className="text-ink font-regular">{label}</div>
    <div className="text-right font-bold text-[#8C877F]">{value}</div>
  </div>
);

export default EarnWithdrawReview;
