import React, { useId } from 'react';

import { useTranslation } from 'react-i18next';

import { RECOVER_FUNDS_PATH } from 'app/pages/recover-funds-paths';
import { AmountInput } from 'components/AmountInput';
import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { Button, ButtonVariant } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { SegmentedControl } from 'components/ui/SegmentedControl';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import { TokenAmount } from 'components/ui/TokenAmount';
import { assetKey } from 'lib/bridge/core/assets';
import { quoteAmounts } from 'lib/bridge/core/quote';
import { ITransactionStatus } from 'lib/miden/db/types';
import { hapticLight } from 'lib/mobile/haptics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { navigate } from 'lib/woozie';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import { useCommandBridge } from './useCommandBridge';

export function CommandBridge(): React.ReactElement {
  const { t } = useTranslation();
  const bridge = useCommandBridge();
  const formId = useId();
  useRegisterCommandFlowBack(bridge.back);
  const route = bridge.operationId ? (bridge.review?.route ?? bridge.route) : bridge.route;
  const sourceKey = route ? assetKey(route.source) : '';
  const sources = new Map(bridge.routes.map(candidate => [assetKey(candidate.source), candidate.source]));
  const destinations = bridge.routes.filter(candidate => assetKey(candidate.source) === sourceKey);
  const isCircleSend = route?.provider === 'xreserve' && route.mode === 'send';
  const networkFeeBudget = bridge.review?.networkFeeBudget ?? bridge.networkFeeBudget;
  useUserVisibleError(
    isCircleSend && !bridge.operationId && bridge.burnFee.status === 'failed' ? 'usdcxBurnFeeUnavailable' : null,
    'review'
  );
  const quote = bridge.review?.quote ?? bridge.quote;
  const amounts = route && quote ? quoteAmounts(route, quote) : undefined;
  const locked = bridge.isSubmitting || Boolean(bridge.operationId);
  const { row, loaded, readFailed } = useTransactionRow(bridge.operationId ?? '');
  const stoppedBeforeSource =
    loaded &&
    !readFailed &&
    bridge.operationId !== undefined &&
    row?.id === bridge.operationId &&
    row.type === 'bridged-receive' &&
    row.status === ITransactionStatus.Completed &&
    !row.restoredFromBackup &&
    !row.recovered &&
    row.extraInputs.phase === 'submitting' &&
    !row.extraInputs.evmTxHash &&
    !row.extraInputs.intentNonce &&
    !row.extraInputs.bridgeOperation?.approvals?.length &&
    row.extraInputs.bridgeOperation?.sourceAttempt?.phase === 'stopped-before-source';
  const footer = bridge.operationId ? (
    <Button
      type="button"
      className="w-full max-w-none sm:w-auto sm:min-w-40"
      onClick={() => {
        hapticLight();
        navigate(stoppedBeforeSource ? '/history' : `/history-details/${bridge.operationId}`);
      }}
    >
      {t(stoppedBeforeSource ? 'activity' : 'commandBridgeViewStatus')}
    </Button>
  ) : (
    <Button
      type="submit"
      form={formId}
      className="w-full max-w-none sm:w-auto sm:min-w-40"
      disabled={locked || (bridge.review ? false : !bridge.canReview)}
      isLoading={bridge.isSubmitting}
    >
      {t(bridge.review ? 'confirm' : bridge.isQuoting ? 'preparing' : 'reviewDetails')}
    </Button>
  );
  const details = route ? (
    <DetailCard>
      <DetailRow label={t('commandBridgeEnvironment')}>{bridge.environment}</DetailRow>
      <DetailRow label={t('commandBridgeProvider')}>{t(`commandBridgeProvider_${route.provider}`)}</DetailRow>
      {amounts && (
        <DetailRow label={t(isCircleSend ? 'amount' : 'commandBridgeSourceTotal')}>
          <TokenAmount amount={amounts.sourceTotal} symbol={route.source.symbol} formatting="exact" />
        </DetailRow>
      )}
      {isCircleSend && (
        <DetailRow label={t('networkFeeMax')} sub={t('usdcxSponsorshipFee', { symbol: route.source.symbol })}>
          {networkFeeBudget ? (
            <TokenAmount
              amount={BigInt(networkFeeBudget.maxAmount)}
              decimals={route.source.decimals}
              symbol={route.source.symbol}
              formatting="exact"
            />
          ) : (
            <span role="status">
              {t(bridge.burnFee.status === 'pending' ? 'usdcxBurnFeeMeasuring' : 'usdcxBurnFeeUnavailable')}
            </span>
          )}
        </DetailRow>
      )}
      {amounts?.fee !== undefined && (
        <DetailRow
          label={t(route.provider === 'xreserve' && route.mode === 'send' ? 'usdcxCircleFee' : 'commandBridgeFee')}
          sub={route.provider === 'xreserve' && route.mode === 'send' ? t('usdcxPayoutFeeVaries') : undefined}
        >
          <TokenAmount
            amount={amounts.fee}
            symbol={route.mode === 'send' ? route.destination.symbol : route.source.symbol}
            formatting="exact"
          />
        </DetailRow>
      )}
    </DetailCard>
  ) : undefined;
  const outlets = useCommandWorkbenchSlots(
    <>
      {!bridge.review && !locked && (
        <TextAction className="mr-auto" onClick={() => navigate(RECOVER_FUNDS_PATH)}>
          {t('recoverLockedFunds')}
        </TextAction>
      )}
      {footer}
    </>,
    details
  );
  return (
    <div data-testid="command-bridge" className="flex flex-col gap-4">
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={event => {
          event.preventDefault();
          if (locked) return;
          hapticLight();
          if (bridge.review) void bridge.submit();
          else bridge.reviewTransfer();
        }}
      >
        {bridge.review && route ? (
          <DetailCard>
            <DetailRow label={t('commandBridgeFrom')} stacked>
              {route.source.symbol} · {route.source.network}
            </DetailRow>
            <DetailRow label={t('commandBridgeTo')} stacked>
              {route.destination.symbol} · {route.destination.network}
            </DetailRow>
            <DetailRow label={t('amount')}>
              <TokenAmount amount={bridge.review.amount} symbol={route.source.symbol} formatting="exact" />
            </DetailRow>
            <DetailRow label={t('commandBridgeExternalAccount')} stacked>
              {bridge.review.accounts.evmAddress}
            </DetailRow>
            <DetailRow label={t('commandBridgeMidenAccount')} stacked>
              {bridge.review.accounts.midenAccount}
            </DetailRow>
            <DetailRow label={t('commandBridgeReceiveEstimate')}>
              <TokenAmount amount={quote?.received} symbol={route.destination.symbol} formatting="exact" />
            </DetailRow>
          </DetailCard>
        ) : (
          <fieldset disabled={locked} className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
            <SegmentedControl
              aria-label={t('commandBridgeDirection')}
              value={bridge.direction}
              items={[
                { id: 'in', label: t('bridgeInTitle') },
                { id: 'out', label: t('commandBridgeOut') }
              ]}
              onChange={bridge.setDirection}
              layout="fill"
              className="lg:col-span-2 lg:max-w-sm"
            />
            <div className="flex min-w-0 flex-wrap gap-2 lg:col-span-2">
              <Button
                type="button"
                variant={bridge.connected ? ButtonVariant.Secondary : ButtonVariant.Primary}
                onClick={() => {
                  hapticLight();
                  void bridge.connectWallet();
                }}
              >
                {t(bridge.connected ? 'connectAnotherWallet' : 'connectEvmWallet')}
              </Button>
              {bridge.direction === 'in' && bridge.connected && (
                <Button
                  type="button"
                  variant={ButtonVariant.Secondary}
                  onClick={() => {
                    hapticLight();
                    void bridge.switchSource();
                  }}
                >
                  {t('commandBridgeSwitchSource')}
                </Button>
              )}
            </div>
            <div className="lg:col-span-2">
              <DetailCard>
                <DetailRow
                  label={t('commandBridgeEnvironment')}
                  action={{ label: t('commandBridgeChangeNetwork'), onClick: () => navigate('/settings/networks') }}
                >
                  {bridge.environment}
                </DetailRow>
              </DetailCard>
            </div>
            <label className="grid min-w-0 gap-2 rounded-2xl border border-hairline bg-fill/40 p-4 text-label text-muted">
              {t('commandBridgeFrom')}
              <select
                className="min-h-11 w-full rounded-xl border border-hairline bg-page px-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
                data-testid="command-bridge-source"
                value={sourceKey}
                disabled={!route}
                onChange={event => {
                  const candidate = bridge.routes.find(item => assetKey(item.source) === event.target.value);
                  if (candidate) bridge.selectRoute(candidate.id);
                }}
              >
                {!route && <option value="">{t('unavailable')}</option>}
                {Array.from(sources, ([key, asset]) => (
                  <option key={key} value={key}>
                    {asset.symbol} · {asset.network}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-2 rounded-2xl border border-hairline bg-fill/40 p-4 text-label text-muted">
              {t('commandBridgeTo')}
              <select
                className="min-h-11 w-full rounded-xl border border-hairline bg-page px-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
                data-testid="command-bridge-destination"
                value={route?.id ?? ''}
                disabled={!route}
                onChange={event => bridge.selectRoute(event.target.value)}
              >
                {!route && <option value="">{t('unavailable')}</option>}
                {destinations.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.destination.symbol} · {item.destination.network} ·{' '}
                    {t(`commandBridgeProvider_${item.provider}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex min-w-0 flex-col gap-4">
              <TextField
                label={t('commandBridgeExternalAccount')}
                value={bridge.externalAccountId}
                readOnly={bridge.direction === 'in'}
                onChange={event => bridge.setExternalAccountId(event.target.value)}
              />
            </div>
            {route && (
              <div className="min-w-0 rounded-2xl border border-hairline bg-fill/40 p-4 sm:p-5">
                <AmountInput
                  aria-label={t('amount')}
                  label={t('amount')}
                  value={bridge.amount}
                  onValueChange={value => bridge.setAmount(value ?? '')}
                  preservePrecision
                  maxLength={128}
                  decimalsLimit={route.source.decimals}
                  formatValueOnBlur={false}
                  tokenSelector={route.source.symbol}
                />
                <div className="mt-3 border-t border-hairline pt-3">
                  <DetailRow label={t('commandBridgeReceiveEstimate')}>
                    <TokenAmount amount={bridge.quote?.received} symbol={route.destination.symbol} rounding="down" />
                  </DetailRow>
                </div>
              </div>
            )}
          </fieldset>
        )}
        {bridge.blocked && <Notice>{t('commandBridgeEpochReceiveUnavailable')}</Notice>}
        {!route && <Notice>{t('commandBridgeNoRoutes')}</Notice>}
        {route?.mode === 'receive' && bridge.cap.status !== 'allowed' && (
          <Notice>{t('commandBridgeBalanceCap')}</Notice>
        )}
        {bridge.operationId && (
          <Notice>{t(stoppedBeforeSource ? 'bridgeStoppedBeforeSending' : 'commandBridgeAdmitted')}</Notice>
        )}
        <ErrorLine errorId="bridgeReviewChanged">
          {bridge.error && !stoppedBeforeSource ? t('bridgeReviewChanged') : undefined}
        </ErrorLine>
      </form>
      {outlets}
    </div>
  );
}
