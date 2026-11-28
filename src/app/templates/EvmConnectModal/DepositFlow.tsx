import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { usePageActive } from 'app/layouts/page-active';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { PageHeader } from 'components/PageHeader';
import { Spinner } from 'components/ui/Spinner';
import type { RelaySource } from 'lib/evm-relay/source';
import { type RelayServiceState, useRelayService } from 'lib/evm-relay/use-relay-service';
import type { NearIntentsConfig } from 'lib/one-click/types';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import type { WalletAccount } from 'lib/shared/types';
import { resolveSelection } from 'screens/near-intents-flow/chains';
import { useNearIntentsCatalog } from 'screens/near-intents-flow/useNearIntentsCatalog';

import type { DepositTokenSheetRows, RelayFormReport, RelayHandover, RelayOpeningForm } from './deposit-handover';
import { depositPairs, pairOfRelay } from './deposit-pairs';
import { NEAR_ROUTE_ID } from './deposit-routes';
import { type DepositUnavailableCause, DepositUnavailable } from './DepositUnavailable';
import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';
import { nearRefundAddressOf, nearRouteOption } from './near-deposit';
import { NearDepositFlow } from './NearDepositFlow';
import { depositSourceNetworks, relayTokenChoiceId, relayTokenChoices } from './relay-token-choices';
import { useNearDepositQuote } from './useNearDepositQuote';

/** Which screen runs the Deposit flow: the relay screen, or the NEAR Intents flow on a pair. */
type FlowMode = { kind: 'relay'; opening?: RelayOpeningForm } | { kind: 'near'; pairId?: string; amount: string };

export interface DepositFlowProps {
  /** The Miden account that receives the deposit. */
  midenAccount: WalletAccount;
  /** The relay address of the account as the source, or null when the relay is off. */
  relaySource: RelaySource | null;
  /** The NEAR Intents config, or null when NEAR Intents is off. */
  nearConfig: NearIntentsConfig | null;
  /** `?pending=<id>`: the pending relay deposit that the relay screen opens on. */
  pendingDepositId?: string;
  onClose: () => void;
  onExit: () => void;
  reportDeposit?: ReportDeposit;
  /**
   * Why the relay is not the source (`off` or `no-address`), for the "not available" page when NEAR Intents has no route
   * either. Ignored while the relay is the source.
   */
  relayOffCause: DepositUnavailableCause;
}

/**
 * The Deposit flow with its routes: the relay routes (Agglayer, Epoch, Circle xReserve) through the relay screen, and
 * NEAR Intents through `NearDepositFlow`. One token sheet lists the pairs of both. The relay screen runs a pair that the
 * relay serves; a pair that only NEAR Intents serves, or a pick of NEAR Intents in the route sheet, hands the selection
 * to the NEAR Intents flow, and a pick of a relay route or a relay token there hands it back.
 */
export const DepositFlow: React.FC<DepositFlowProps> = ({
  midenAccount,
  relaySource,
  nearConfig,
  pendingDepositId,
  onClose,
  onExit,
  reportDeposit,
  relayOffCause
}) => {
  const { t } = useTranslation();
  const pageActive = usePageActive();
  const bridgeConfig = useBridgeConfigSnapshot();
  const nativeUsdFaucetId = useMidenFaucetId();
  const catalogState = useNearIntentsCatalog(nearConfig);
  const catalog = catalogState.status === 'ready' ? catalogState.catalog : undefined;

  // What the relay service serves (`GET /v1/chains`), read once when the page opens. Nothing reads the deposit address
  // before its address step: the served chains and the gas mode come from this answer.
  const relayService = useRelayService(relaySource !== null);
  const servedChains = servedChainsOf(relayService);
  const relayChains = relayChainsOf(relayService);
  const relayChoices = useMemo(
    () =>
      relaySource === null || relayChains === null
        ? []
        : relayTokenChoices(
            bridgeConfig,
            depositSourceNetworks(bridgeConfig, relayChains),
            nativeUsdFaucetId ?? undefined
          ),
    [bridgeConfig, nativeUsdFaucetId, relayChains, relaySource]
  );
  // The relay routes are offered only when the service answered in `sponsor` mode and serves a chain with a token.
  const relayOffered = relaySource !== null && relayChoices.length > 0;
  // A pending deposit (`?pending=<id>`) opens on the relay screen whatever the service answered: the user already has
  // its address. Its address step reads the arrival and says when its chain is not served. Once the screen leaves that
  // deposit (the review or the amount step), only an offered relay keeps it.
  const [pendingOpen, setPendingOpen] = useState(pendingDepositId !== undefined);
  const relayShown = relaySource !== null && (relayOffered || pendingOpen);
  const unreachableLogged = useRef(false);
  useEffect(() => {
    if (relayService.status !== 'unreachable' || unreachableLogged.current) return;
    unreachableLogged.current = true;
    console.warn('[deposit] the relay service cannot be reached, so no relay route is offered:', relayService.error);
  }, [relayService]);
  const pairs = useMemo(() => {
    const relayNetworks = relayChoices
      .map(choice => choice.option.network)
      .filter((network, index, all) => all.findIndex(other => other.id === network.id) === index);
    return depositPairs(relayChoices, relayNetworks, catalog);
  }, [catalog, relayChoices]);

  const [mode, setMode] = useState<FlowMode>(() =>
    relaySource === null ? { kind: 'near', amount: '' } : { kind: 'relay' }
  );
  // What the relay screen has on screen, for the NEAR Intents route of its pair.
  const [relayForm, setRelayForm] = useState<RelayFormReport | null>(null);
  const handleFormChange = useCallback((form: RelayFormReport) => {
    setRelayForm(form);
    if (form.step === 'amount' || form.step === 'review') setPendingOpen(false);
  }, []);
  const relayMode = relayShown && (mode.kind === 'relay' || catalogState.status !== 'ready');

  const relayPair =
    relayForm === null ? undefined : pairOfRelay(pairs, relayTokenChoiceId(relayForm.chainId, relayForm.token));
  const relayNearRoute = useMemo(
    () =>
      catalog === undefined || relayPair?.near === undefined ? undefined : resolveSelection(catalog, relayPair.near),
    [catalog, relayPair?.near]
  );
  // The NEAR Intents quote of the relay screen's pair and amount, for its row in the route sheet. It runs only on the
  // amount step, where the sheet opens.
  const relayNearQuote = useNearDepositQuote({
    config: nearConfig,
    route: relayMode ? relayNearRoute : undefined,
    amount: relayForm?.amount ?? '',
    refundTo:
      relayNearRoute === undefined ? undefined : nearRefundAddressOf(midenAccount, relayNearRoute.chain.addressKind),
    recipient: midenAccount.publicKey,
    active: pageActive && relayMode && relayForm?.step === 'amount'
  });
  const otherRoutes = useMemo(
    () =>
      relayNearRoute === undefined
        ? undefined
        : [
            nearRouteOption({
              name: t('depositFlowNearRoute'),
              arrivesIn: t('depositFlowNearArrives'),
              loadingText: t('loading'),
              quote: relayNearQuote.quote,
              waiting: relayNearQuote.amountUnits !== undefined && relayNearQuote.loading,
              sourceDecimals: relayNearRoute.token.asset.decimals,
              outputDecimals: relayNearRoute.output.decimals,
              selected: false
            })
          ],
    [relayNearQuote.amountUnits, relayNearQuote.loading, relayNearQuote.quote, relayNearRoute, t]
  );
  const tokenSheet = useMemo<DepositTokenSheetRows | undefined>(
    () =>
      catalog === undefined ? undefined : { networks: pairs.networks, tokens: pairs.pairs.map(pair => pair.option) },
    [catalog, pairs]
  );

  // The relay screen hands over: a pick of NEAR Intents in the route sheet, or of a row that only NEAR Intents serves.
  const handleOtherRoute = useCallback(
    (id: string) => {
      if (id !== NEAR_ROUTE_ID || relayPair?.near === undefined) return;
      setMode({ kind: 'near', pairId: relayPair.option.id, amount: relayForm?.amount ?? '' });
    },
    [relayForm?.amount, relayPair]
  );
  const handleOtherToken = useCallback(
    (id: string) => {
      const pair = pairs.pairs.find(candidate => candidate.option.id === id);
      if (pair?.near === undefined) return;
      setMode({ kind: 'near', pairId: id, amount: relayForm?.amount ?? '' });
    },
    [pairs, relayForm?.amount]
  );
  // The NEAR Intents flow hands back: a pick of a relay route, or of a row that the relay serves.
  const handleRelay = useCallback(
    ({ pairId, amount, route }: RelayHandover) => {
      const relay = pairs.pairs.find(candidate => candidate.option.id === pairId)?.relay;
      if (relay === undefined || !relayOffered) return;
      setRelayForm(null);
      setRelayUnsupported(false);
      setMode({ kind: 'relay', opening: { chainId: relay.chainId, token: relay.token, amount, route } });
    },
    [pairs, relayOffered]
  );
  // The relay answers `deduct` gas mode, which the flow does not support yet: NEAR Intents takes the pair when it serves
  // it, else the flow is not available.
  const [relayUnsupported, setRelayUnsupported] = useState(false);
  const handleRelayUnsupported = useCallback(() => {
    if (relayPair?.near !== undefined) {
      setMode({ kind: 'near', pairId: relayPair.option.id, amount: relayForm?.amount ?? '' });
      return;
    }
    setRelayUnsupported(true);
  }, [relayForm?.amount, relayPair]);

  if (relaySource !== null && mode.kind === 'relay' && relayUnsupported) {
    return <DepositUnavailable cause="deduct" onBack={onClose} onClose={onExit} />;
  }

  // The relay screen runs while it has the flow, and also when the NEAR Intents catalogue is not there.
  if (relaySource !== null && relayShown && (mode.kind === 'relay' || catalog === undefined)) {
    const opening = mode.kind === 'relay' ? mode.opening : undefined;
    return (
      <EvmBridgeDepositScreen
        evmAddress={relaySource.address}
        relaySource={relaySource}
        relayServedChains={servedChains}
        midenAccount={midenAccount}
        onRelayUnsupported={handleRelayUnsupported}
        onClose={onClose}
        onExit={onExit}
        // A pending deposit opens the first screen only: a hand-over back opens the form it carries.
        pendingDepositId={opening === undefined ? pendingDepositId : undefined}
        reportDeposit={reportDeposit}
        initialForm={opening}
        tokenSheet={tokenSheet}
        onOtherToken={handleOtherToken}
        otherRoutes={otherRoutes}
        onOtherRoute={handleOtherRoute}
        onFormChange={handleFormChange}
      />
    );
  }

  // The service answer is not there yet: wait for it, so the flow does not open on NEAR Intents and then move.
  if (relaySource !== null && relayService.status === 'loading') return <DepositLoading onBack={onClose} />;

  if (nearConfig !== null && catalog !== undefined) {
    const near = mode.kind === 'near' ? mode : { pairId: undefined, amount: '' };
    return (
      <NearDepositFlow
        config={nearConfig}
        catalog={catalog}
        midenAccount={midenAccount}
        pairs={pairs}
        initialPairId={near.pairId}
        initialAmount={near.amount}
        onRelay={handleRelay}
        onClose={onClose}
      />
    );
  }

  if (catalogState.status === 'loading') return <DepositLoading onBack={onClose} />;

  return (
    <DepositUnavailable
      cause={unavailableCauseOf(relaySource, relayService, relayOffCause)}
      onBack={onClose}
      onClose={onExit}
    />
  );
};

/** The flow's frame with a spinner, while the relay service or the NEAR Intents catalogue loads. */
const DepositLoading: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-ink">
      <NetworkModeBanner />
      <div className="shrink-0 px-4">
        <PageHeader title={t('depositFlowTitle')} onBack={onBack} />
      </div>
      <div className="flex justify-center pt-5" data-testid="deposit-near-loading">
        <Spinner />
      </div>
    </div>
  );
};

/** The chains that the service serves, or undefined while its answer is not known. */
function servedChainsOf(state: RelayServiceState): readonly number[] | undefined {
  return state.status === 'ready' ? state.service.chains : undefined;
}

/** The chains of the relay routes: the served chains while the service answers in `sponsor` mode, else null. */
function relayChainsOf(state: RelayServiceState): readonly number[] | null {
  return state.status === 'ready' && state.service.mode === 'sponsor' ? state.service.chains : null;
}

/**
 * Why the flow is not available when no route serves it: the relay is off for the account (`relayOffCause`), the
 * service cannot be reached, it answers `deduct` gas mode, or it serves no chain with a token (`off`).
 */
function unavailableCauseOf(
  relaySource: RelaySource | null,
  state: RelayServiceState,
  relayOffCause: DepositUnavailableCause
): DepositUnavailableCause {
  if (relaySource === null) return relayOffCause;
  switch (state.status) {
    case 'unreachable':
      return 'unreachable';
    case 'ready':
      return state.service.mode === 'deduct' ? 'deduct' : 'off';
    case 'off':
    case 'loading':
    default:
      return 'off';
  }
}
