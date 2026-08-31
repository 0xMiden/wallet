import React, { FC, useMemo, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CircleButton } from 'components/CircleButton';
import { TokenLogo } from 'components/TokenLogo';
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
      <header className="shrink-0 border-b border-rule-default px-4 pb-4 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <CircleButton
            icon={IconName.ChevronLeft}
            onClick={goBack}
            className="h-10 w-10 bg-gray-25 text-heading-gray hover:bg-gray-50 focus:bg-gray-50"
            size="md"
            aria-label={t('back')}
          />
          <h1 className="min-w-0 truncate font-heading text-[26px] font-bold leading-none text-heading-gray">
            {position.protocol} &bull; {position.asset}
          </h1>
          <span className="shrink-0 rounded-full bg-[#DDD4CE] px-3 py-1.5 text-xs font-medium leading-none text-heading-gray">
            {position.asset} on {position.network}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className={clsx('flex flex-col px-6 pt-6')}>
          <span className="font-heading text-2xl font-bold leading-none text-gray">{t('earnWithdrawAmount')}</span>
          <div className="mt-3 font-heading text-[4rem] font-bold leading-none text-heading-gray">
            {toAdaptiveFixed(amountValue)}
          </div>
          <div className="flex items-center gap-1">
            <TokenLogo symbol={withdrawSymbol} size="md" />
            <span className="font-heading text-2xl font-bold text-heading-gray">{withdrawSymbol}</span>
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
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-4 text-sm leading-tight">
    <div className="text-heading-gray font-regular">{label}</div>
    <div className="text-right font-bold text-[#8C877F]">{value}</div>
  </div>
);

export default EarnWithdrawReview;
