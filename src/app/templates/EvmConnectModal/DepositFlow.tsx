import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { PageHeader } from 'components/PageHeader';
import { Spinner } from 'components/ui/Spinner';
import type { RelaySource } from 'lib/evm-relay/source';
import { type RelayServiceState, useRelayService } from 'lib/evm-relay/use-relay-service';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import type { WalletAccount } from 'lib/shared/types';

import type { RelayFormReport } from './deposit-handover';
import { type DepositUnavailableCause, DepositUnavailable } from './DepositUnavailable';
import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';
import { depositSourceNetworks, relayTokenChoices } from './relay-token-choices';

export interface DepositFlowProps {
  /** The Miden account that receives the deposit. */
  midenAccount: WalletAccount;
  /** The relay address of the account as the source, or null when the relay is off. */
  relaySource: RelaySource | null;
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

/** The Deposit flow with its routes: the relay routes (Agglayer, Epoch, Circle xReserve) through the relay screen. */
export const DepositFlow: React.FC<DepositFlowProps> = ({
  midenAccount,
  relaySource,
  pendingDepositId,
  onClose,
  onExit,
  reportDeposit,
  relayOffCause
}) => {
  const bridgeConfig = useBridgeConfigSnapshot();
  const nativeUsdFaucetId = useMidenFaucetId();

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

  const handleFormChange = useCallback((form: RelayFormReport) => {
    if (form.step === 'amount' || form.step === 'review') setPendingOpen(false);
  }, []);

  // The relay answers `deduct` gas mode, which the flow does not support yet: the flow is not available.
  const [relayUnsupported, setRelayUnsupported] = useState(false);
  const handleRelayUnsupported = useCallback(() => {
    setRelayUnsupported(true);
  }, []);

  if (relaySource !== null && relayUnsupported) {
    return <DepositUnavailable cause="deduct" onBack={onClose} onClose={onExit} />;
  }

  if (relaySource !== null && relayShown) {
    return (
      <EvmBridgeDepositScreen
        evmAddress={relaySource.address}
        relaySource={relaySource}
        relayServedChains={servedChains}
        midenAccount={midenAccount}
        onRelayUnsupported={handleRelayUnsupported}
        onClose={onClose}
        onExit={onExit}
        pendingDepositId={pendingDepositId}
        reportDeposit={reportDeposit}
        onFormChange={handleFormChange}
      />
    );
  }

  // The service answer is not there yet: wait for it.
  if (relaySource !== null && relayService.status === 'loading') return <DepositLoading onBack={onClose} />;

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
