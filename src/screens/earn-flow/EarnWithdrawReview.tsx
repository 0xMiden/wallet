import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { amountCaptionClassName, amountFigureClassName } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkLogo } from 'components/NetworkChip';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { TokenUsdValue } from 'components/TokenUsdValue';
import { DetailCard, DetailDisclosure, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { quoteEarnWithdrawal, type EarnWithdrawalQuote } from 'lib/epoch/earn-withdraw-quote';
import { withdrawalAmount, withdrawalAmountError } from 'lib/epoch/withdraw-amount';
import { useAccount } from 'lib/miden/front';
import { isUserErrorId, UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { goBack, navigate, Redirect, useLocation } from 'lib/woozie';
import { EvmUsdValue } from 'screens/generating-transaction/EvmUsdValue';
import { truncateAddress } from 'utils/string';

import {
  EarnAmountUnit,
  EarnAssetMark,
  EarnHero,
  EarnSubjectSubtitle,
  earnSubjectTitle,
  useEarnAssetFaucetId
} from './components';
import { EARN_PLACEHOLDER, placeholderPosition } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { EarnPosition } from './types';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

interface EarnWithdrawReviewProps {
  positionId: string;
}

const coversAmount = (position: EarnPosition, amount: string) =>
  withdrawalAmountError(amount, position.withdrawable, position.decimals) === undefined;

/**
 * Whether two reads of a position agree on every value its withdrawal quote reviews. The available balance is not
 * one: the submit check needs only that it still covers the reviewed amount. A kept read the balance has moved past,
 * either way, is replaced, so the next quote is asked against a balance that agrees with the amount check.
 */
const sameReviewedPosition = (a: EarnPosition | undefined, b: EarnPosition | undefined, amount: string) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    coversAmount(a, amount) === coversAmount(b, amount) &&
    a.id === b.id &&
    a.owner === b.owner &&
    a.marketUid === b.marketUid &&
    a.underlyingAddress === b.underlyingAddress &&
    a.decimals === b.decimals &&
    a.stale === b.stale);

/** Review the selected amount against its quote. A URL without an amount goes back to the amount step. */
const EarnWithdrawReview: FC<EarnWithdrawReviewProps> = ({ positionId }) => {
  const { t } = useTranslation();
  const assetFaucetId = useEarnAssetFaucetId();
  const { positions, isLoading, error, errorDiagnostics, refetch } = useEarnPositions();
  const found = useMemo(() => positions.find(item => item.id === positionId), [positions, positionId]);
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get('amount');
  const amount = requested ?? '';
  // Every positions refresh rebuilds the object, so the quote keeps the reviewed read until a reviewed value changes.
  const [reviewed, setReviewed] = useState(found);
  if (!sameReviewedPosition(reviewed, found, amount)) setReviewed(found);
  const position = useMemo(() => found ?? placeholderPosition(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error });
  const account = useAccount();
  const withdrawSymbol = found?.asset ?? 'USDC';
  const validation = withdrawalAmountError(amount, position.withdrawable, position.decimals);
  const [quote, setQuote] = useState<EarnWithdrawalQuote>();
  const [quoteError, setQuoteError] = useState<string>();
  const [submitInvalidatedQuote, setSubmitInvalidatedQuote] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setQuote(undefined);
    setQuoteError(undefined);
    setSubmitInvalidatedQuote(false);
    if (reviewed && !reviewed.stale && !validation) {
      void quoteEarnWithdrawal({ position: reviewed, amount, accountId: account.publicKey })
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
  }, [amount, reviewed, account.publicKey, account.evmAddress, validation, refresh]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorId, setSubmitErrorId] = useState<UserErrorId | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // A submit-caused quote refresh shares its report only when the owning submit notice is visible.
  const validationMessageId = validation ?? (submitInvalidatedQuote && submitError ? undefined : quoteError);

  // Every submission carries a quote, so an unquoted full-balance withdrawal has no way in.
  if (requested === null) return <Redirect to={`/earn/positions/${encodeURIComponent(positionId)}/withdraw`} />;
  const selectedUnits = withdrawalAmount(amount, position.decimals);
  const availableUnits = withdrawalAmount(position.withdrawable, position.decimals);
  const remaining =
    selectedUnits !== null && availableUnits !== null && selectedUnits <= availableUnits
      ? formatUnits(availableUnits - selectedUnits, position.decimals)
      : undefined;
  const expectedReceipt = quote && formatUnits(BigInt(quote.expectedAtomic), quote.destinationDecimals);
  const minimumReceipt = quote && formatUnits(BigInt(quote.minimumAtomic), quote.destinationDecimals);
  const receiptDisplay =
    quote && expectedReceipt ? formatMoneyAmount(expectedReceipt, 'receives', quote.destinationSymbol) : undefined;
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
    if (submitting.current || isSubmitting || position.stale || validation || !quote) return;
    if (!account.evmAddress || account.evmAddress.toLowerCase() !== position.owner.toLowerCase()) {
      setSubmitError(t('earnWithdrawNotOwned'));
      setSubmitErrorId('earnWithdrawNotOwned');
      return;
    }
    submitting.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await gaslessEarnWithdrawalToMiden({
        midenAccountPublicKey: account.publicKey,
        evmAddress: account.evmAddress,
        marketUid: position.marketUid,
        protocol: position.epochProtocol,
        chainId: Number(position.marketUid.split(':')[1]),
        underlyingAddress: position.underlyingAddress,
        amount,
        review: quote,
        underlyingDecimals: position.decimals,
        // No Miden-side transaction happens (gasless EVM intent sign), so the
        // handoff goes to the bespoke withdraw status screen — not the
        // prove/submit generating-transaction page.
        onRowCreated: txId =>
          navigate({
            pathname: `/earn/withdraw-status/${encodeURIComponent(txId)}`,
            state: { newSubmissionTxId: txId }
          })
      });
    } catch (e) {
      // If the row was already created we have navigated away and the
      // generating screen renders the failed phase; this only surfaces
      // pre-row validation errors.
      setSubmitError(e instanceof Error ? t(e.message) : t('earnGaslessWithdrawalFailed'));
      setSubmitErrorId(
        e instanceof Error
          ? isUserErrorId(e.message)
            ? e.message
            : 'raw_earn_withdraw_submit_failed'
          : 'earnGaslessWithdrawalFailed'
      );
      setQuote(undefined);
      setQuoteError('earnWithdrawRefresh');
      setSubmitInvalidatedQuote(true);
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
        headerActions={
          found && <EarnAssetMark asset={found.asset} network={found.network} faucetId={assetFaucetId} decorative />
        }
        footerLayout="stack"
        footer={
          (loadFailed && !found) || pending ? undefined : (
            <>
              {submitError && (
                <Notice errorId={submitErrorId} tone="negative" role="alert" data-testid="earn-withdraw-review-error">
                  {submitError}
                </Notice>
              )}
              <Button
                data-testid="earn-withdraw-review-confirm"
                title={isSubmitting ? t('withdrawing') : t('withdraw')}
                variant={ButtonVariant.Primary}
                accent="earn"
                onClick={handleWithdraw}
                disabled={isSubmitting || Boolean(validation) || !position.id || position.stale || !quote}
                className="w-full max-w-none"
              />
            </>
          )
        }
      >
        {loadFailed && !found ? (
          <EarnLoadError errorDiagnostics={errorDiagnostics} onRetry={refetch} className="mt-10" />
        ) : pending ? null : (
          <>
            {loadFailed && <EarnLoadError errorDiagnostics={errorDiagnostics} onRetry={refetch} />}
            <EarnHero
              labelId="earn-withdraw-review-amount"
              value={
                expectedReceipt && quote ? (
                  <>
                    <span className="text-hero-name text-muted">≈ </span>
                    {receiptDisplay}
                  </>
                ) : (
                  EARN_PLACEHOLDER
                )
              }
              // The deposit review's hero: the amount step's caption and entry sizes over the compact unit.
              className="mt-7"
              labelClassName={amountCaptionClassName}
              figureClassName={classNames('mt-3 text-ink break-words', amountFigureClassName(receiptDisplay))}
              unit={
                quote && (
                  <EarnAmountUnit symbol={quote.destinationSymbol} faucetId={quote.destinationFaucetId} compact />
                )
              }
              label={t('youReceive')}
              layout="label-first"
              meta={
                quote &&
                expectedReceipt && (
                  <TokenUsdValue
                    amount={expectedReceipt}
                    decimals={quote.destinationDecimals}
                    faucetId={quote.destinationFaucetId}
                    symbol={quote.destinationSymbol}
                  />
                )
              }
            />

            {/* Keep the financial choices visible. Exact amounts and route context stay available in Details. */}
            {(validation || quoteError) && (
              <Notice
                errorId={isUserErrorId(validationMessageId) ? validationMessageId : null}
                tone="negative"
                role="alert"
              >
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
            <DetailCard surface="outline" face="heading">
              <DetailRow
                label={t('earnWithdrawYouWithdraw')}
                sub={
                  <>
                    {amount === position.withdrawable ? t('earnWithdrawAll') : undefined}
                    <EvmUsdValue
                      amount={amount}
                      decimals={position.decimals}
                      chainId={Number(position.marketUid.split(':')[1])}
                      address={position.underlyingAddress}
                      className="block"
                    />
                  </>
                }
              >
                <span>
                  {compact(amount, withdrawSymbol)} {withdrawSymbol}
                </span>
              </DetailRow>
              <DetailRow
                label={t('earnWithdrawStaysInvested')}
                data-testid="earn-withdraw-remaining"
                sub={
                  remaining !== undefined && (
                    <EvmUsdValue
                      amount={remaining}
                      decimals={position.decimals}
                      chainId={Number(position.marketUid.split(':')[1])}
                      address={position.underlyingAddress}
                    />
                  )
                }
              >
                {remainingLabel}
              </DetailRow>
              <DetailRow
                label={t('earnWithdrawMinimumReceipt')}
                sub={
                  quote &&
                  minimumReceipt && (
                    <TokenUsdValue
                      amount={minimumReceipt}
                      decimals={quote.destinationDecimals}
                      faucetId={quote.destinationFaucetId}
                      symbol={quote.destinationSymbol}
                    />
                  )
                }
              >
                {minimumLabel}
              </DetailRow>
              {/* Where and when the payout lands, as the send review's Network row: the network's mark beside its name. */}
              <DetailRow label={t('earnWithdrawArrivesOn')}>
                <span className="flex items-center gap-1.5">
                  <NetworkLogo kind="miden" />
                  {t('earnWithdrawArrivesOnValue', { network: t('miden') })}
                </span>
              </DetailRow>
              <DetailRow label={t('earnWithdrawGas')}>
                <span className="text-positive-tint-ink">{t('earnWithdrawGasSponsored')}</span>
              </DetailRow>
              <DetailDisclosure
                title={t('details')}
                summary={`${position.network} → Miden`}
                open={detailsOpen}
                onOpenChange={setDetailsOpen}
                data-testid="earn-withdraw-details"
              >
                <DetailRow label={t('route')}>{`${position.protocol} (${position.network}) -> Miden`}</DetailRow>
                <DetailRow label={t('positionOwnerLabel')}>{truncateAddress(position.owner, false, 8, 8)}</DetailRow>
                <DetailRow
                  label={t('earnWithdrawExactAmount')}
                  stacked
                  sub={
                    <EvmUsdValue
                      amount={amount}
                      decimals={position.decimals}
                      chainId={Number(position.marketUid.split(':')[1])}
                      address={position.underlyingAddress}
                    />
                  }
                >
                  {amount} {withdrawSymbol}
                </DetailRow>
                {quote && expectedReceipt && minimumReceipt && (
                  <>
                    <DetailRow
                      label={t('earnWithdrawExpectedReceipt')}
                      stacked
                      sub={
                        <TokenUsdValue
                          amount={expectedReceipt}
                          decimals={quote.destinationDecimals}
                          faucetId={quote.destinationFaucetId}
                          symbol={quote.destinationSymbol}
                        />
                      }
                    >
                      {expectedReceipt} {quote.destinationSymbol}
                    </DetailRow>
                    <DetailRow
                      label={t('earnWithdrawMinimumReceipt')}
                      stacked
                      sub={
                        <TokenUsdValue
                          amount={minimumReceipt}
                          decimals={quote.destinationDecimals}
                          faucetId={quote.destinationFaucetId}
                          symbol={quote.destinationSymbol}
                        />
                      }
                    >
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
