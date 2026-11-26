import React, { useCallback, useMemo } from 'react';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { DepositFlow } from 'app/templates/EvmConnectModal/DepositFlow';
import { type DepositUnavailableCause, DepositUnavailable } from 'app/templates/EvmConnectModal/DepositUnavailable';
import { getRelayBaseUrl } from 'lib/evm-relay/base-url';
import { relaySourceOf } from 'lib/evm-relay/source';
import { useNearIntentsConfig } from 'lib/one-click/config';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { getRelayConfig } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import { PENDING_DEPOSIT_PARAM } from 'screens/deposit-flow/pending-deposit-route';

interface BridgeDepositProps {
  onClose?: () => void;
}

/**
 * Why the relay is not the source of the current account: it is off for this network (no relay config or no base URL),
 * or it is on and the account has no deposit address (`relayEvmAddress`).
 */
function relayOffCauseOf(): DepositUnavailableCause {
  return getRelayConfig() !== null && getRelayBaseUrl() !== null ? 'no-address' : 'off';
}

/**
 * `/bridge/deposit`: the Deposit flow (`DepositFlow`), from the relay address of the current account and through NEAR
 * Intents, with no connect step. When neither serves the account, one "not available" page says why.
 */
export const BridgeDeposit: React.FC<BridgeDepositProps> = ({ onClose }) => {
  const goBack = useBackWithFallback();
  const { search } = useLocation();
  const currentMidenAccount = useWalletStore(s => s.currentAccount);
  // `relaySourceOf` reads the config snapshot as it is, so a new snapshot reads the relay source again.
  const bridgeConfig = useBridgeConfigSnapshot();
  const nearConfig = useNearIntentsConfig();
  // `?pending=<id>`: the relay flow opens on that pending deposit (the Home row, the arrival notice).
  const pendingDepositId = new URLSearchParams(search).get(PENDING_DEPOSIT_PARAM) ?? undefined;
  const relaySource = useMemo(
    () => relaySourceOf(currentMidenAccount),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the snapshot is what `relaySourceOf` reads
    [bridgeConfig, currentMidenAccount]
  );
  // This surface owns the `fund` flow.
  const reportDeposit = useFundTelemetry();

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    goBack();
  }, [goBack, onClose]);

  // The X leaves the flow altogether: back returns to the previous screen, close returns Home.
  const handleExit = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    navigate('/');
  }, [onClose]);

  if ((relaySource !== null || nearConfig !== null) && currentMidenAccount) {
    return (
      <DepositFlow
        midenAccount={currentMidenAccount}
        relaySource={relaySource}
        nearConfig={nearConfig}
        pendingDepositId={pendingDepositId}
        onClose={handleClose}
        onExit={handleExit}
        reportDeposit={reportDeposit}
        relayOffCause={relayOffCauseOf()}
      />
    );
  }

  return <DepositUnavailable cause={relayOffCauseOf()} onBack={handleClose} onClose={handleExit} />;
};

export default BridgeDeposit;
