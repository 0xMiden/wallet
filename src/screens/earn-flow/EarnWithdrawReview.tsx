import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { DetailCard, DetailDisclosure, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { quoteEarnWithdrawal, type EarnWithdrawalQuote } from 'lib/epoch/earn-withdraw-quote';
import { withdrawalAmount, withdrawalAmountError } from 'lib/epoch/withdraw-amount';
import { useAccount } from 'lib/miden/front';
import { goBack, navigate, useLocation } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { EarnAmountUnit, EarnAssetMark, EarnHero, EarnSubjectSubtitle, earnSubjectTitle } from './components';
import { EARN_PLACEHOLDER, placeholderPosition } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

interface EarnWithdrawReviewProps {
  positionId: string;
}

/** Review the fixed selected amount. Legacy full-withdraw links retain their recovery path. */
const EarnWithdrawReview: FC<EarnWithdrawReviewProps> = ({ positionId }) => {
  const { t } = useTranslation();
  const { positions, isLoading, error, refetch } = useEarnPositions();
  const found = useMemo(() => positions.find(item => item.id === positionId), [positions, positionId]);
  const position = useMemo(() => found ?? placeholderPosition(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error });
  const account = useAccount();
  const withdrawSymbol = found?.asset ?? 'USDC';
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get('amount');
  // Older deep links have no amount. Snapshot their full amount once; later reads cannot increase it.
  const legacy = useRef<{ id: string; amount: string }>();
  if (found && legacy.current?.id !== positionId) legacy.current = { id: positionId, amount: found.withdrawable };
  const amount = requested ?? legacy.current?.amount ?? '0';
  const validation = withdrawalAmountError(amount, position.withdrawable, position.decimals);
  const [quote, setQuote] = useState<EarnWithdrawalQuote>();
  const [quoteError, setQuoteError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef(false);
  const latest = useRef({ accountId: account.publicKey, owner: account.evmAddress, position, amount });
  latest.current = { accountId: account.publicKey, owner: account.evmAddress, position, amount };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setQuote(undefined);
    setQuoteError(undefined);
    if (requested !== null && found && !found.stale && !validation) {
      void quoteEarnWithdrawal({ position: found, amount, accountId: account.publicKey })
        .then(next => {
          if (!active) return;
          setQuote(next);
          timer = setTimeout(
            () => {
              setQuote(undefined);
              setQuoteError('earnWithdrawRefresh');
            },
            Math.max(0, next.expiresAt - Date.now())
          );
        })
        .catch((e: unknown) => {
          if (active)
            setQuoteError(
              e instanceof Error && e.message === 'earnWithdrawRefresh' ? e.message : 'earnWithdrawQuoteUnavailable'
            );
        });
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [requested, amount, found, account.publicKey, account.evmAddress, validation, refresh]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selectedUnits = withdrawalAmount(amount, position.decimals);
  const availableUnits = withdrawalAmount(position.withdrawable, position.decimals);
  const remaining =
    selectedUnits !== null && availableUnits !== null && selectedUnits <= availableUnits
      ? formatUnits(availableUnits - selectedUnits, position.decimals)
      : undefined;
  const expectedReceipt = quote && formatUnits(BigInt(quote.expectedAtomic), quote.destinationDecimals);
  const minimumReceipt = quote && formatUnits(BigInt(quote.minimumAtomic), quote.destinationDecimals);
  const compact = (value: string, symbol: string) => {
    const display = formatMoneyAmount(value, 'receives', symbol);
    return display === formatMoneyAmount(value, 'typed', symbol)
      ? display
      : t('earnWithdrawApproxAmount', { amount: display });
  };
  const remainingLabel =
    remaining !== undefined ? `${compact(remaining, withdrawSymbol)} ${withdrawSymbol}` : EARN_PLACEHOLDER;
  const minimumLabel =
    quote && minimumReceipt
      ? `${formatMoneyAmount(minimumReceipt, 'receives', quote.destinationSymbol)} ${quote.destinationSymbol}`
      : EARN_PLACEHOLDER;

  // `Button` fires the tap haptic itself; calling it here too would buzz twice.
  const handleWithdraw = async () => {
    // A position the latest read did not load signs nothing; the disabled button and the notice say why.
    if (submitting.current || isSubmitting || position.stale || validation || (requested !== null && !quote)) return;
    if (!account.evmAddress || account.evmAddress.toLowerCase() !== position.owner.toLowerCase()) {
      setSubmitError(t('earnWithdrawNotOwned'));
      return;
    }
    submitting.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const current = latest.current;
      if (
        current.accountId !== account.publicKey ||
        current.owner !== account.evmAddress ||
        current.position.stale ||
        current.position.withdrawable !== position.withdrawable ||
        current.amount !== amount
      ) {
        throw new Error('earnWithdrawRefresh');
      }
      await gaslessEarnWithdrawalToMiden({
        midenAccountPublicKey: account.publicKey,
        evmAddress: account.evmAddress,
        marketUid: position.marketUid,
        underlyingAddress: position.underlyingAddress,
        amount,
        ...(quote ? { review: quote } : {}),
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
      setSubmitError(e instanceof Error ? t(e.message) : t('earnGaslessWithdrawalFailed'));
      if (requested !== null) {
        setQuote(undefined);
        setQuoteError('earnWithdrawRefresh');
      }
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg">
      <NetworkModeBanner />
      {/* The shared pushed-page frame, so this review and the deposit review are one page shape.
          Until the position is found the header names the route, never a placeholder position,
          and the CTA waits with the body. */}
      <SubPageLayout
        data-testid="earn-withdraw-review-page"
        title={found ? earnSubjectTitle(found) : t('withdraw')}
        subtitle={found && <EarnSubjectSubtitle subject={found} />}
        onBack={goBack}
        headerActions={found && <EarnAssetMark asset={found.asset} network={found.network} decorative />}
        footerLayout="stack"
        footer={
          (loadFailed && !found) || pending ? undefined : (
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
                disabled={
                  isSubmitting ||
                  Boolean(validation) ||
                  !position.id ||
                  position.stale ||
                  (requested !== null && !quote)
                }
                className="w-full max-w-none"
              />
            </>
          )
        }
      >
        {loadFailed && !found ? (
          <EarnLoadError onRetry={refetch} className="mt-10" />
        ) : pending ? null : (
          <>
            {loadFailed && <EarnLoadError onRetry={refetch} />}
            <EarnHero
              labelId="earn-withdraw-review-amount"
              value={
                requested !== null ? (
                  expectedReceipt && quote ? (
                    <>
                      <span className="text-hero-name text-muted">≈ </span>
                      {formatMoneyAmount(expectedReceipt, 'receives', quote.destinationSymbol)}
                    </>
                  ) : (
                    EARN_PLACEHOLDER
                  )
                ) : (
                  formatMoneyAmount(amount, 'receives', withdrawSymbol)
                )
              }
              valueClassName="text-ink break-words"
              unit={
                requested !== null ? (
                  quote && <EarnAmountUnit symbol={quote.destinationSymbol} />
                ) : (
                  <EarnAmountUnit symbol={withdrawSymbol} />
                )
              }
              label={t(requested !== null ? 'youReceive' : 'earnWithdrawAmount')}
              layout="label-first"
            >
              <p className="mt-2 text-caption text-muted face-heading">{t('earnWithdrawDeliverySummary')}</p>
            </EarnHero>

            {/* Keep the financial choices visible. Exact amounts and route context stay available in Details. */}
            {requested !== null && (
              <>
                {(validation || quoteError) && (
                  <Notice tone="negative" role="alert">
                    {t(validation ?? quoteError!, { decimals: position.decimals })}
                  </Notice>
                )}
                {quoteError && (
                  <Button
                    title={t('earnWithdrawRefreshQuote')}
                    variant={ButtonVariant.Secondary}
                    disabled={isSubmitting}
                    onClick={() => {
                      setSubmitError(null);
                      refetch();
                      setRefresh(n => n + 1);
                    }}
                  />
                )}
              </>
            )}
            <DetailCard face="heading">
              {requested !== null && (
                <>
                  <DetailRow
                    label={t('earnWithdrawYouWithdraw')}
                    sub={amount === position.withdrawable ? t('earnWithdrawAll') : undefined}
                  >
                    <span>
                      {compact(amount, withdrawSymbol)} {withdrawSymbol}
                    </span>
                  </DetailRow>
                  <DetailRow label={t('earnWithdrawStaysInvested')} data-testid="earn-withdraw-remaining">
                    {remainingLabel}
                  </DetailRow>
                  <DetailRow label={t('earnWithdrawMinimumReceipt')}>{minimumLabel}</DetailRow>
                </>
              )}
              <DetailDisclosure
                title={t('details')}
                summary={`${position.network} → Miden`}
                open={detailsOpen}
                onOpenChange={setDetailsOpen}
                data-testid="earn-withdraw-details"
              >
                <DetailRow label={t('route')}>{`${position.protocol} (${position.network}) -> Miden`}</DetailRow>
                <DetailRow label={t('positionOwnerLabel')}>{truncateAddress(position.owner, false, 8, 8)}</DetailRow>
                <DetailRow label={t('earnWithdrawExactAmount')} stacked>
                  {amount} {withdrawSymbol}
                </DetailRow>
                {quote && expectedReceipt && minimumReceipt && (
                  <>
                    <DetailRow label={t('earnWithdrawExpectedReceipt')} stacked>
                      {expectedReceipt} {quote.destinationSymbol}
                    </DetailRow>
                    <DetailRow label={t('earnWithdrawMinimumReceipt')} stacked>
                      {minimumReceipt} {quote.destinationSymbol}
                    </DetailRow>
                  </>
                )}
                <DetailRow label={t('earnWithdrawalLabel')}>
                  {t(amount === position.withdrawable ? 'earnFullPositionGasless' : 'earnSelectedAmountGasless')}
                </DetailRow>
                <DetailRow label={t('earnWithdrawRouteFees')} stacked>
                  {t('earnWithdrawFeesIncluded')}
                </DetailRow>
              </DetailDisclosure>
            </DetailCard>
          </>
        )}
      </SubPageLayout>
    </div>
  );
};

export default EarnWithdrawReview;
