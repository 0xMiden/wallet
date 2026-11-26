import React, { useId } from 'react';

import { useTranslation } from 'react-i18next';

import { RECOVER_FUNDS_PATH } from 'app/pages/recover-funds-paths';
import { AmountInput } from 'components/AmountInput';
import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
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
import { getBridgeNetwork } from 'screens/send-flow/bridge-networks';
import { truncateHash } from 'utils/string';

import {
  externalSide,
  networkChoices,
  pairRoutes,
  routeForNetwork,
  tokenChoices,
  type BridgeSide
} from './bridge-selection';
import { BridgePicker, type BridgePickerOption } from './BridgePicker';
import { useCommandBridge } from './useCommandBridge';

const SIDES: readonly BridgeSide[] = ['source', 'destination'];

export function CommandBridge(): React.ReactElement {
  const { t } = useTranslation();
  const bridge = useCommandBridge();
  const formId = useId();
  useRegisterCommandFlowBack(bridge.back);
  const route = bridge.operationId ? (bridge.review?.route ?? bridge.route) : bridge.route;
  const external = bridge.direction === 'in' ? 'source' : 'destination';
  const networkOptions: BridgePickerOption[] = route
    ? networkChoices(bridge.routes).map(network => ({
        id: network,
        label: getBridgeNetwork(network)?.name ?? network,
        icon: size => <NetworkLogo kind="ethereum" network={network} size={size} />
      }))
    : [];
  const tokenOptions = (side: BridgeSide): BridgePickerOption[] => {
    if (!route) return [];
    const choices = tokenChoices(bridge.routes, route, side);
    return choices.map(({ asset, route: choice }) => {
      const identifier = asset.kind === 'erc20' ? asset.address : asset.kind === 'miden' ? asset.faucetId : undefined;
      const miden = choice[externalSide(choice) === 'source' ? 'destination' : 'source'];
      const providers = new Set(
        pairRoutes(bridge.routes, choice).map(item => t(`commandBridgeProvider_${item.provider}`))
      );
      return {
        id: assetKey(asset),
        label: asset.symbol,
        detail:
          choices.filter(other => other.asset.symbol === asset.symbol).length > 1
            ? [[...providers].join(', '), identifier && truncateHash(identifier)].filter(Boolean).join(' · ')
            : undefined,
        keywords: [asset.name, identifier].filter(Boolean).join(' '),
        icon: size => <TokenLogo faucetId={miden.kind === 'miden' ? miden.faucetId : undefined} size={size} />
      };
    });
  };
  const pair = route ? pairRoutes(bridge.routes, route) : [];
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
            {SIDES.map(side => (
              <section
                key={side}
                role="group"
                aria-labelledby={`${formId}-${side}`}
                className="grid min-w-0 gap-3 rounded-2xl border border-hairline bg-fill/40 p-4"
              >
                <h3 id={`${formId}-${side}`} className="text-label text-muted">
                  {t(side === 'source' ? 'commandBridgeFrom' : 'commandBridgeTo')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {side === external ? (
                    <BridgePicker
                      menuLabel={t('selectNetwork')}
                      value={route?.[external].network ?? ''}
                      options={networkOptions}
                      onChange={network => {
                        const next = route && routeForNetwork(bridge.routes, route, network);
                        if (next) bridge.selectRoute(next.id);
                      }}
                      data-testid={`command-bridge-${side}-network`}
                    />
                  ) : (
                    <BridgePicker
                      menuLabel={t('selectNetwork')}
                      value="miden"
                      options={[
                        { id: 'miden', label: t('miden'), icon: size => <NetworkLogo kind="miden" size={size} /> }
                      ]}
                      onChange={() => undefined}
                      data-testid={`command-bridge-${side}-network`}
                    />
                  )}
                  <BridgePicker
                    menuLabel={t('selectAToken')}
                    value={route ? assetKey(route[side]) : ''}
                    options={tokenOptions(side)}
                    onChange={id => {
                      const choice =
                        route && tokenChoices(bridge.routes, route, side).find(c => assetKey(c.asset) === id);
                      if (choice) bridge.selectRoute(choice.route.id);
                    }}
                    searchable
                    data-testid={`command-bridge-${side}-token`}
                  />
                </div>
                {route && side === 'source' && (
                  <AmountInput
                    aria-label={t('amount')}
                    label={t('amount')}
                    value={bridge.amount}
                    onValueChange={value => bridge.setAmount(value ?? '')}
                    preservePrecision
                    maxLength={128}
                    decimalsLimit={route.source.decimals}
                    formatValueOnBlur={false}
                  />
                )}
                {route && side === 'destination' && (
                  <DetailRow label={t('commandBridgeReceiveEstimate')}>
                    <TokenAmount amount={bridge.quote?.received} symbol={route.destination.symbol} rounding="down" />
                  </DetailRow>
                )}
              </section>
            ))}
            {route &&
              (pair.length >= 2 ? (
                <ChoiceCardGroup
                  aria-label={t('route')}
                  items={pair.map(item => ({
                    id: item.id,
                    title: t(`commandBridgeProvider_${item.provider}`),
                    'data-testid': `command-bridge-route-${item.provider}`
                  }))}
                  value={route.id}
                  onChange={bridge.selectRoute}
                  className="sm:grid-cols-3 lg:col-span-2"
                />
              ) : (
                <p
                  data-testid="command-bridge-via"
                  data-provider={route.provider}
                  className="text-caption text-muted lg:col-span-2"
                >
                  {t('commandBridgeVia', { provider: t(`commandBridgeProvider_${route.provider}`) })}
                </p>
              ))}
            <div className="flex min-w-0 flex-col gap-4">
              <TextField
                label={t('commandBridgeExternalAccount')}
                value={bridge.externalAccountId}
                readOnly={bridge.direction === 'in'}
                onChange={event => bridge.setExternalAccountId(event.target.value)}
              />
            </div>
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
