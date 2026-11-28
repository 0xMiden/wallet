import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { FlowAccent } from 'components/flow/accent';
import { Card, CardButton } from 'components/ui/Card';
import { DetailCard } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SegmentedControl } from 'components/ui/SegmentedControl';
import { SelectionCheck } from 'components/ui/SelectionCheck';
import { Skeleton } from 'components/ui/Skeleton';
import { formatUsdDisplay } from 'lib/i18n/amount-display';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { nearIntentsEvmChainId } from 'lib/one-click/chains';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useWalletStore } from 'lib/store';
import type { FeatureUnavailableFeature } from 'lib/telemetry/ui-producer-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

import {
  formatNearIntentsAmount,
  nearIntentsAmount,
  nearIntentsArrivalText,
  nearIntentsFeeUsd
} from './near-intents-format';
import { BridgeRouteMetrics, BridgeRouteRanking, rankBridgeRoutes } from './route-ranking';
import { BridgeRoute } from './types';
import { UsdcxPayoutRows, UsdcxPayoutTarget } from './UsdcxPayoutRows';
import { AgglayerEligibility } from './useAgglayerEligibility';
import type { NearIntentsSendQuote, NearIntentsSendQuoteErrorCode } from './useNearIntentsSendQuote';

export type RoutePayout = { assetId: string; amount: string; symbol: string };
export type RouteSortOrder = Extract<BridgeRouteRanking, 'best-value' | 'fastest'>;

export const RouteSort: React.FC<{
  value: RouteSortOrder;
  onChange: (value: RouteSortOrder) => void;
  accent: FlowAccent;
}> = ({ value, onChange, accent }) => {
  const { t } = useTranslation();
  return (
    <SegmentedControl
      items={[
        { id: 'best-value', label: t('bridgeRankBestPrice') },
        { id: 'fastest', label: t('bridgeRankFastest') }
      ]}
      value={value}
      onChange={onChange}
      layout="fill"
      accent={accent}
      aria-label={t('bridgeRouteSort')}
    />
  );
};

export interface RouteStepProps {
  payouts?: Partial<Record<'epoch' | 'agglayer', RoutePayout>>;
  accent?: FlowAccent;
  usdcxAvailable?: boolean;
  route: BridgeRoute;
  onRouteChange: (route: BridgeRoute) => void;
  /** Fast-route fee in USD (input value − quoted USDC out). undefined while quoting / unavailable. */
  fastFeeUsd?: number;
  fastQuoteLoading: boolean;
  /** Extra message rendered with the selected route card (e.g. a token or balance notice). */
  notice?: React.ReactNode;
  /** Disable the confirm button — e.g. the quote isn't ready, or an unsupported route+token combo. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Each route's feature: an unavailable or still-loading route is greyed out and takes no tap. */
  fastFeature?: FeatureUnavailableFeature;
  slowFeature?: FeatureUnavailableFeature;
  fastAvailability: FeatureAvailability;
  slowAvailability: FeatureAvailability;
}

export interface RouteCardProps {
  emoji: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  fee: React.ReactNode;
  feeLabelKey?: string;
  /** The arrival estimate: a text, or a skeleton while a quote loads. */
  eta: React.ReactNode;
  payout?: RoutePayout;
  testId?: string;
  accent: FlowAccent;
  disabled?: boolean;
  loading?: boolean;
  /** Id of the notice that explains why the card is disabled. */
  describedBy?: string;
  /** Help remains readable inside the card, outside the disabled tap target. */
  description?: React.ReactNode;
}

/** One selectable route row. Shared with the USDCx deposit route step. */
export const RouteCard: React.FC<RouteCardProps> = ({
  label,
  selected,
  onSelect,
  fee,
  feeLabelKey = 'bridgeRouteFee',
  eta,
  payout,
  testId,
  accent,
  disabled,
  loading,
  describedBy,
  description
}) => (
  <Card surface="outline" padding="none" data-testid={testId ? `${testId}-card` : undefined}>
    <CardButton
      surface="outline"
      padding="none"
      type="button"
      data-testid={testId}
      onClick={onSelect}
      aria-pressed={selected}
      disabled={disabled}
      aria-busy={loading}
      aria-describedby={describedBy}
      className="w-full border-0 disabled:opacity-50"
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <span className="text-title-section text-ink">{label}</span>
        {selected && <SelectionCheck accent={accent} />}
      </div>
      <div className="grid grid-cols-2 gap-4 border-t border-hairline px-4 py-3">
        {payout && <RouteMetric labelKey="youReceive">{`${payout.amount} ${payout.symbol}`}</RouteMetric>}
        <RouteMetric labelKey={feeLabelKey}>{fee}</RouteMetric>
        <RouteMetric labelKey="bridgeArrivalEstimate">{eta}</RouteMetric>
      </div>
    </CardButton>
    {description && <div className="flex flex-col gap-2 border-t border-hairline px-4 py-3">{description}</div>}
  </Card>
);

const RouteMetric: React.FC<{ labelKey: string; children: React.ReactNode }> = ({ labelKey, children }) => {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-muted">{t(labelKey)}</span>
      <span className="text-value text-ink">{children}</span>
    </span>
  );
};

export type RouteOptionsProps = Pick<
  RouteStepProps,
  | 'route'
  | 'payouts'
  | 'onRouteChange'
  | 'fastFeeUsd'
  | 'fastQuoteLoading'
  | 'notice'
  | 'usdcxAvailable'
  | 'fastFeature'
  | 'slowFeature'
  | 'fastAvailability'
  | 'slowAvailability'
> & {
  accent?: FlowAccent;
  slowStatus: AgglayerEligibility;
  showFastRoute?: boolean;
  showSlowRoute?: boolean;
  /** A USDCx burn's destination and amount, once the send has both: the card shows Circle's fee and the payout. */
  usdcxPayout?: UsdcxPayoutTarget;
  /** The NEAR Intents card and its quote when the provider offers the network. */
  nearIntentsCard?: React.ReactElement<NearIntentsRouteCardProps>;
  /** False when no bridge route (Epoch, Agglayer, USDCx) serves the network: only `nearIntentsCard` shows. */
  bridgeRoutesAvailable?: boolean;
};

/** Why NEAR Intents gives no quote, for the route card and the review page. Nothing for a quote that is ready. */
export const NearIntentsQuoteMessage: React.FC<{ quote: NearIntentsSendQuote; id?: string }> = ({ quote, id }) => {
  const { t } = useTranslation();
  switch (quote.status) {
    case 'unsupported':
      return (
        <p id={id} className="text-caption text-muted" data-testid="near-intents-route-unsupported">
          {t('nearIntentsSendUnsupported')}
        </p>
      );
    case 'error': {
      const errorId = nearIntentsQuoteErrorId(quote.errorCode);
      return (
        <Notice tone="warning" variant="inline" id={id} errorId={errorId} data-testid="near-intents-route-error">
          {t(errorId)}
        </Notice>
      );
    }
    default:
      return null;
  }
};

/** The message (and the user-visible error id) of a refused NEAR Intents quote. */
export function nearIntentsQuoteErrorId(
  code: NearIntentsSendQuoteErrorCode | undefined
): 'nearIntentsSendNoLiquidity' | 'nearIntentsSendInvalidRecipient' | 'oneClickQuoteUnavailable' {
  switch (code) {
    case 'no_liquidity':
      return 'nearIntentsSendNoLiquidity';
    case 'invalid_recipient':
      return 'nearIntentsSendInvalidRecipient';
    default:
      return 'oneClickQuoteUnavailable';
  }
}

const NEAR_INTENTS_NOTICE_ID = 'bridge-route-near-intents-status';
// Built in plain JS (not JSX), so the dash does not trip the no-literal-string i18n lint.
const NO_VALUE = '—';

export interface NearIntentsRouteCardProps {
  quote: NearIntentsSendQuote;
  selected: boolean;
  onSelect: () => void;
  accent: FlowAccent;
  /** Extra message for the selected card (e.g. a token or balance notice). */
  hint?: React.ReactNode;
}

const NEAR_INTENTS_HINT_ID = 'bridge-route-near-intents-hint';

/**
 * The NEAR Intents route card. It has the same two metrics as the other cards: the bridge fee in USD and the arrival
 * estimate. The amount the recipient gets is a caption under them. The card is disabled when NEAR Intents can give
 * no quote for this send.
 */
export const NearIntentsRouteCard: React.FC<NearIntentsRouteCardProps> = ({
  quote,
  selected,
  onSelect,
  accent,
  hint
}) => {
  const { t } = useTranslation();
  const loading = quote.status === 'loading';
  const ready = quote.status === 'ready' ? quote.quote : undefined;
  const destination = quote.pair?.destination;
  const receives =
    ready && destination ? formatNearIntentsAmount(ready.quote.amountOut, destination.decimals) : undefined;
  const feeUsd = ready ? nearIntentsFeeUsd(ready.quote) : undefined;
  // Drawn as the Fast fee is, or the dash when there is no value.
  const feeText = feeUsd !== undefined ? formatUsdDisplay(feeUsd) : NO_VALUE;
  const fee = loading ? (
    <Skeleton className="h-4 w-12" />
  ) : (
    <span className="text-base font-bold text-ink" data-testid="near-intents-route-fee">
      {feeText}
    </span>
  );
  const eta = loading ? (
    <Skeleton className="h-4 w-12" />
  ) : (
    <span data-testid="near-intents-route-eta">
      {ready ? nearIntentsArrivalText(t, ready.quote.timeEstimate) : NO_VALUE}
    </span>
  );
  const hasMessage = quote.status === 'unsupported' || quote.status === 'error';
  const shownHint = selected ? hint : undefined;
  const receiveLine =
    receives !== undefined && destination
      ? t('nearIntentsSendYouReceive', { amount: receives, symbol: destination.symbol })
      : undefined;
  const describedBy = (() => {
    if (hasMessage) return NEAR_INTENTS_NOTICE_ID;
    if (shownHint) return NEAR_INTENTS_HINT_ID;
    return undefined;
  })();

  return (
    <RouteCard
      emoji=""
      label={t('bridgeRouteNearIntents')}
      selected={selected}
      onSelect={() => {
        if (!selected) onSelect();
      }}
      fee={fee}
      eta={eta}
      disabled={hasMessage}
      loading={loading}
      describedBy={describedBy}
      testId="bridge-route-near-intents"
      accent={accent}
      description={
        hasMessage || shownHint || receiveLine ? (
          <>
            {/* Outside the two metrics, so a long amount wraps here and never runs into the second column. */}
            {receiveLine && (
              <p className="min-w-0 text-caption text-muted wrap-break-word" data-testid="near-intents-route-receives">
                {receiveLine}
              </p>
            )}
            <NearIntentsQuoteMessage quote={quote} id={NEAR_INTENTS_NOTICE_ID} />
            {shownHint && (
              <p id={NEAR_INTENTS_HINT_ID} className="text-caption text-muted">
                {shownHint}
              </p>
            )}
          </>
        ) : undefined
      }
    />
  );
};

/** The USDCx burn's one route card. Its fees are paid in the native asset, so the subtitle names that asset. */
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange' | 'usdcxPayout' | 'accent'>> = ({
  route,
  onRouteChange,
  usdcxPayout,
  accent = 'brand'
}) => {
  const { t } = useTranslation();
  const nativeFaucetId = useNativeFeeFaucetId();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeSymbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol;

  return (
    <>
      <RouteCard
        emoji=""
        label={t('usdcxRouteLabel')}
        selected={route === 'usdcx'}
        onSelect={() => {
          if (route !== 'usdcx') {
            onRouteChange('usdcx');
          }
        }}
        fee={t('usdcxMidenFees', { symbol: nativeSymbol })}
        feeLabelKey="networkFee"
        eta={t('bridgePayoutTiming')}
        testId="bridge-route-usdcx"
        accent={accent}
        describedBy="usdcx-burn-notice"
        description={
          <p className="text-caption text-muted" data-testid="usdcx-burn-notice" id="usdcx-burn-notice">
            {t('usdcxWithdrawalNotice')}
          </p>
        }
      />
      {usdcxPayout && (
        <DetailCard>
          <UsdcxPayoutRows chainId={usdcxPayout.chainId} />
        </DetailCard>
      )}
    </>
  );
};

// Each notice answers for its own route, so the card points at it by id (one RouteOptions per screen).
const FAST_NOTICE_ID = 'bridge-route-fast-unavailable';
const SLOW_NOTICE_ID = 'bridge-route-slow-unavailable';

/**
 * Availability describes a route before submission, never a failed transaction. The copy offers the
 * other route only when that card can be chosen now.
 */
const RouteAvailabilityNotice: React.FC<{
  availability: FeatureAvailability;
  feature?: FeatureUnavailableFeature;
  otherRouteSelectable: boolean;
  id: string;
  'data-testid': string;
}> = ({ availability, feature = 'unknown', otherRouteSelectable, id, 'data-testid': testId }) => {
  const { t } = useTranslation();
  // The same report FeatureUnavailableNotice makes, so the neutral copy keeps the event stream it replaced.
  useUserVisibleError(
    availability.state === 'unavailable' && availability.reason !== 'restricted' && availability.reason !== 'pending'
      ? 'bridgeFeatureUnavailableBody'
      : null,
    'notice',
    undefined,
    {
      kind: 'feature_unavailable',
      featureUnavailableFeature: feature,
      featureUnavailableReason:
        availability.state === 'unavailable' &&
        ['off', 'not-configured', 'not-deployed', 'service-down'].includes(availability.reason)
          ? (availability.reason as 'off' | 'not-configured' | 'not-deployed' | 'service-down')
          : 'unknown'
    }
  );
  if (availability.state !== 'unavailable') return null;
  if (availability.reason === 'restricted') {
    return <FeatureUnavailableNotice availability={availability} variant="inline" id={id} data-testid={testId} />;
  }
  return (
    <Notice tone="neutral" variant="inline" id={id} data-testid={testId}>
      {t(otherRouteSelectable ? 'bridgeRouteUnavailableBody' : 'bridgeRouteNoneAvailableBody')}
    </Notice>
  );
};

/** The Fast / Slow route cards and their notice, shared by every route step's layout. */
export const RouteOptions: React.FC<RouteOptionsProps> = ({
  route,
  onRouteChange,
  fastFeeUsd,
  payouts,
  fastQuoteLoading,
  notice,
  usdcxAvailable,
  slowStatus,
  fastFeature,
  slowFeature,
  fastAvailability,
  slowAvailability,
  accent = 'brand',
  usdcxPayout,
  showFastRoute = true,
  showSlowRoute = true,
  nearIntentsCard,
  bridgeRoutesAvailable = true
}) => {
  const { t } = useTranslation();
  const [ranking, setRanking] = useState<RouteSortOrder>('best-value');
  const slowAllowed = slowStatus === 'allowed';
  const fastSelectable = showFastRoute && !isFeatureBlocked(fastAvailability);
  const slowSelectable = showSlowRoute && slowAllowed && !isFeatureBlocked(slowAvailability);
  let slowFee: React.ReactNode = <span className="text-base font-bold text-ink">{t('noFee')}</span>;
  let slowNotice: React.ReactNode;
  switch (slowStatus) {
    case 'loading':
      slowFee = <Skeleton className="h-4 w-12" />;
      slowNotice = t('agglayerCheckingToken');
      break;
    case 'unsupported':
      slowFee = t('unavailable');
      slowNotice = t('agglayerTokenUnsupported');
      break;
    case 'error':
      slowFee = t('unavailable');
      slowNotice = t('agglayerTokenCheckFailed');
      break;
  }

  const select = (next: BridgeRoute) => {
    if (next === route) return;
    onRouteChange(next);
  };

  // Only NEAR Intents serves this network (Solana, Bitcoin, NEAR, or an EVM chain with no bridge).
  if (!bridgeRoutesAvailable) {
    return <div className="mt-4 flex flex-col gap-4">{nearIntentsCard}</div>;
  }

  // Built in plain JS (not JSX) so the em-dash fallback doesn't trip the
  // no-literal-string i18n lint; "$1.84" is excluded as a $-prefixed value.
  const feeText = fastFeeUsd != null ? formatUsdDisplay(fastFeeUsd) : '—';
  const fastFee = fastQuoteLoading ? (
    <Skeleton className="h-4 w-12" />
  ) : (
    <span className="text-base font-bold text-ink">{feeText}</span>
  );

  const fastHint = route === 'epoch' ? notice : undefined;
  const slowHint = route === 'agglayer' ? notice : undefined;

  const fastCard = (
    <RouteCard
      emoji="⚡"
      label={t('bridgeRouteEpoch')}
      selected={route === 'epoch'}
      onSelect={() => select('epoch')}
      fee={fastFee}
      eta={t('fastArrival')}
      payout={fastSelectable ? payouts?.epoch : undefined}
      disabled={!fastSelectable}
      describedBy={
        fastAvailability.state === 'unavailable' ? FAST_NOTICE_ID : fastHint ? 'bridge-route-fast-hint' : undefined
      }
      testId="bridge-route-fast"
      accent={accent}
      description={
        fastAvailability.state === 'unavailable' || fastHint ? (
          <>
            <RouteAvailabilityNotice
              availability={fastAvailability}
              feature={fastFeature}
              otherRouteSelectable={slowSelectable}
              id={FAST_NOTICE_ID}
              data-testid="feature-unavailable-notice-fast"
            />
            {fastHint && (
              <p id="bridge-route-fast-hint" className="text-caption text-muted">
                {fastHint}
              </p>
            )}
          </>
        ) : undefined
      }
    />
  );
  const slowCard = (
    <RouteCard
      emoji="🕐"
      label={t('bridgeRouteAgglayer')}
      selected={route === 'agglayer' && slowAllowed}
      disabled={!slowSelectable}
      loading={slowStatus === 'loading'}
      describedBy={
        slowAvailability.state === 'unavailable'
          ? SLOW_NOTICE_ID
          : slowNotice
            ? 'bridge-route-slow-status'
            : slowHint
              ? 'bridge-route-slow-hint'
              : undefined
      }
      onSelect={() => select('agglayer')}
      fee={slowFee}
      eta={t('slowArrival')}
      payout={slowSelectable ? payouts?.agglayer : undefined}
      testId="bridge-route-slow"
      accent={accent}
      description={
        slowAvailability.state === 'unavailable' || slowNotice || slowHint ? (
          <>
            <RouteAvailabilityNotice
              availability={slowAvailability}
              feature={slowFeature}
              otherRouteSelectable={fastSelectable}
              id={SLOW_NOTICE_ID}
              data-testid="feature-unavailable-notice-slow"
            />
            {slowHint && (
              <p id="bridge-route-slow-hint" className="text-caption text-muted">
                {slowHint}
              </p>
            )}
            {slowNotice && (
              <p id="bridge-route-slow-status" role="status" className="text-caption text-muted">
                {slowNotice}
              </p>
            )}
          </>
        ) : undefined
      }
    />
  );
  const intentsStatus = nearIntentsCard?.props.quote;
  const readyIntents = intentsStatus?.status === 'ready' ? intentsStatus : undefined;
  const intentsChain =
    readyIntents?.pair.chain.addressKind === 'evm' ? nearIntentsEvmChainId(readyIntents.pair.chain.id) : undefined;
  const intentsContract = readyIntents?.pair.destination.contractAddress;
  const intentsAssetId =
    intentsChain !== undefined && intentsContract ? `${intentsChain}:${intentsContract.toLowerCase()}` : undefined;
  const bridgeRoutes = rankBridgeRoutes(
    [
      {
        id: 'epoch',
        visible: showFastRoute,
        disabled: !fastSelectable,
        etaSeconds: 30,
        payout: payouts?.epoch,
        card: fastCard
      },
      {
        id: 'agglayer',
        visible: showSlowRoute,
        disabled: !slowSelectable,
        etaSeconds: 30 * 60,
        payout: payouts?.agglayer,
        card: slowCard
      }
    ].filter(option => option.visible),
    'best-value'
  );
  const sameAsset = payouts?.epoch && payouts.epoch.assetId === payouts.agglayer?.assetId;
  const comparableWithIntents =
    !usdcxAvailable &&
    intentsAssetId !== undefined &&
    bridgeRoutes.filter(option => !option.disabled).at(-1)?.payout?.assetId === intentsAssetId;
  const routes: (BridgeRouteMetrics & { id: string; card: React.ReactElement })[] = usdcxAvailable
    ? [
        {
          id: 'usdcx',
          card: (
            <UsdcxRouteOption route={route} onRouteChange={onRouteChange} usdcxPayout={usdcxPayout} accent={accent} />
          )
        }
      ]
    : bridgeRoutes.map(option => ({
        ...option,
        receivedValue:
          sameAsset || (comparableWithIntents && option.payout?.assetId === intentsAssetId)
            ? option.payout?.amount
            : undefined
      }));
  const keepAssetOrder = ranking === 'best-value' && comparableWithIntents && !sameAsset;
  const firstMatch = routes.findIndex(option => option.receivedValue !== undefined && !option.disabled);
  // Keep the relative position of routes whose destination assets cannot be compared.
  const rankFrom = keepAssetOrder ? Math.max(0, firstMatch) : 0;
  const rankable = routes.slice(rankFrom);
  if (nearIntentsCard) {
    rankable.push({
      id: 'near-intents',
      disabled: intentsStatus?.status === 'error' || intentsStatus?.status === 'unsupported',
      etaSeconds: readyIntents?.quote.quote.timeEstimate,
      receivedValue:
        comparableWithIntents && readyIntents
          ? nearIntentsAmount(readyIntents.quote.quote.amountOut, readyIntents.pair.destination.decimals)?.toFixed()
          : undefined,
      card: nearIntentsCard
    });
  }
  const ranked = [...routes.slice(0, rankFrom), ...rankBridgeRoutes(rankable, ranking)];

  return (
    <div className={usdcxAvailable ? 'mt-6 flex flex-col gap-4' : 'mt-4 flex flex-col gap-4'}>
      {ranked.length > 1 && <RouteSort value={ranking} onChange={setRanking} accent={accent} />}
      {ranked.map(({ id, card }) => (
        <React.Fragment key={id}>{card}</React.Fragment>
      ))}
    </div>
  );
};

/**
 * Cross-chain route picker, shown after the destination network is chosen for a
 * 0x recipient. Fast = Epoch (any token → USDC, settles in ~seconds, charges a
 * fee = input value − USDC received); Slow = Agglayer. The send flow's SendRoute
 * gates Slow on the bridge registry; an EVM deposit has no Miden faucet to check.
 */
export const Route: React.FC<RouteStepProps> = ({
  accent = 'brand',
  usdcxAvailable,
  route,
  onRouteChange,
  fastFeeUsd,
  payouts,
  fastQuoteLoading,
  notice,
  confirmDisabled,
  onConfirm,
  fastFeature,
  slowFeature,
  fastAvailability,
  slowAvailability
}) => {
  const { t } = useTranslation();

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t(
            route === 'agglayer' ? 'bridgeContinueAgglayer' : route === 'epoch' ? 'bridgeContinueEpoch' : 'continue'
          )}
          variant={ButtonVariant.Primary}
          accent={accent}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <SectionHeader size="lg">{t('bridgeChooseRoute')}</SectionHeader>
      <p className="text-body-sm text-muted">{t('bridgeRouteDescription')}</p>
      <RouteOptions
        accent={accent}
        usdcxAvailable={usdcxAvailable}
        route={route}
        onRouteChange={onRouteChange}
        fastFeeUsd={fastFeeUsd}
        payouts={payouts}
        fastQuoteLoading={fastQuoteLoading}
        notice={notice}
        slowStatus="allowed"
        fastFeature={fastFeature}
        slowFeature={slowFeature}
        fastAvailability={fastAvailability}
        slowAvailability={slowAvailability}
      />
    </HomeGroupPaneBody>
  );
};
