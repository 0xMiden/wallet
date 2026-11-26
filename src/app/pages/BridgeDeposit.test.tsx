import React from 'react';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { NearIntentsCatalog, NearIntentsConfig } from 'lib/one-click/types';
import {
  createLocationState,
  HistoryAction,
  navigate,
  Provider as WoozieProvider,
  resetHistoryPosition
} from 'lib/woozie';
import type { NearIntentsCatalogState } from 'screens/near-intents-flow/useNearIntentsCatalog';

import { BridgeDeposit } from './BridgeDeposit';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

// The network banner tops every page of this route. Its sheet and the effective-endpoint lookup are tested in their
// own suites; stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet',
  getEffectiveNetworkName: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { currentAccount: { publicKey: string } }) => unknown) =>
    select({ currentAccount: { publicKey: 'miden-account' } })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'usdcx' }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ status: 'ready' })
}));

// The relay: off unless a case turns it on. With it on, the account has a relay source unless a case removes it.
let mockRelayOn = false;
jest.mock('lib/remote-config/values', () => ({
  ...jest.requireActual('lib/remote-config/values'),
  getRelayConfig: () => (mockRelayOn ? { chains: {} } : null)
}));
jest.mock('lib/evm-relay/base-url', () => ({ getRelayBaseUrl: () => (mockRelayOn ? 'https://relay.test' : null) }));
const RELAY = '0x00000000000000000000000000000000000000e5';
let mockRelaySource: { accountPublicKey: string; address: string } | null = null;
jest.mock('lib/evm-relay/source', () => ({ relaySourceOf: () => mockRelaySource }));

// NEAR Intents: off unless a case sets a config. Its flow is stubbed; `DepositFlow` has its own suite.
let mockNearConfig: NearIntentsConfig | null = null;
jest.mock('lib/one-click/config', () => ({ useNearIntentsConfig: () => mockNearConfig }));
let mockCatalogState: NearIntentsCatalogState = { status: 'unavailable' };
jest.mock('screens/near-intents-flow/useNearIntentsCatalog', () => ({
  useNearIntentsCatalog: (config: NearIntentsConfig | null) =>
    config === null ? { status: 'unavailable' } : mockCatalogState
}));
jest.mock('app/templates/EvmConnectModal/NearDepositFlow', () => ({
  NearDepositFlow: () => <div data-testid="near-deposit-flow" />
}));

jest.mock('components/ui/Button', () => ({
  Button: ({ title, onClick }: { title?: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('app/templates/EvmConnectModal/EvmBridgeDepositScreen', () => ({
  EvmBridgeDepositScreen: ({
    evmAddress,
    relaySource,
    pendingDepositId,
    onClose,
    onExit
  }: {
    evmAddress: string;
    relaySource?: { address: string };
    pendingDepositId?: string;
    onClose: () => void;
    onExit?: () => void;
  }) => (
    <div
      data-testid="bridge-deposit-screen"
      data-source={evmAddress}
      data-relay={relaySource?.address ?? 'none'}
      data-pending={pendingDepositId ?? 'none'}
    >
      <button type="button" onClick={onClose}>
        back
      </button>
      {onExit && (
        <button type="button" onClick={onExit}>
          exit
        </button>
      )}
    </div>
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { WarningFill: 'WarningFill', ArrowLeft: 'ArrowLeft', Close: 'Close', ChevronLeft: 'ChevronLeft' }
}));

const NEAR_CONFIG: NearIntentsConfig = { serviceUrl: 'https://one-click.test', chains: [], midenAssets: [] };
const CATALOG: NearIntentsCatalog = {
  chains: [
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [
        {
          symbol: 'SOL',
          asset: { assetId: 'sol:SOL', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
          outputs: [{ assetId: 'miden:wsol', blockchain: 'miden', symbol: 'wSOL', decimals: 8, faucetId: 'wsol' }]
        }
      ]
    }
  ]
};

let warn: jest.SpyInstance;
beforeEach(() => {
  mockRelayOn = false;
  mockRelaySource = null;
  mockNearConfig = null;
  mockCatalogState = { status: 'ready', catalog: CATALOG };
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  navigate('/bridge/deposit', HistoryAction.Replace);
  resetHistoryPosition();
});
afterEach(() => {
  warn.mockRestore();
  cleanup();
});

describe('BridgeDeposit: the relay serves the account', () => {
  beforeEach(() => {
    mockRelayOn = true;
    mockRelaySource = { accountPublicKey: 'miden-account', address: RELAY };
  });

  it('opens the deposit screen on the relay address, with no connect step', () => {
    render(<BridgeDeposit />);

    const depositScreen = screen.getByTestId('bridge-deposit-screen');
    expect(depositScreen).toHaveAttribute('data-source', RELAY);
    expect(depositScreen).toHaveAttribute('data-relay', RELAY);
    expect(screen.queryByText('bridgeConnectWalletAction')).not.toBeInTheDocument();
  });

  it('opens the relay flow on the pending deposit that the query names', () => {
    navigate('/bridge/deposit?pending=pending-7', HistoryAction.Replace);
    render(
      <WoozieProvider>
        <BridgeDeposit />
      </WoozieProvider>
    );

    expect(screen.getByTestId('bridge-deposit-screen')).toHaveAttribute('data-pending', 'pending-7');
  });

  it('names no pending deposit without the query, and leaves for Home from the close', () => {
    render(
      <WoozieProvider>
        <BridgeDeposit />
      </WoozieProvider>
    );

    expect(screen.getByTestId('bridge-deposit-screen')).toHaveAttribute('data-pending', 'none');
    fireEvent.click(screen.getByRole('button', { name: 'exit' }));
    expect(createLocationState()).toMatchObject({ pathname: '/' });
  });

  it.each(['/', '/receive'])('returns to %s on back', async origin => {
    navigate(origin, HistoryAction.Replace);
    navigate('/bridge/deposit');
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    await waitFor(() => expect(createLocationState().pathname).toBe(origin));
    expect(createLocationState()).toMatchObject({ trigger: HistoryAction.Pop, historyPosition: 0 });
  });

  it('uses an explicit close handler for back and close when provided', () => {
    const onClose = jest.fn();
    render(<BridgeDeposit onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    fireEvent.click(screen.getByRole('button', { name: 'exit' }));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(createLocationState().pathname).toBe('/bridge/deposit');
  });

  it('opens the relay screen when NEAR Intents serves the account too', () => {
    mockNearConfig = NEAR_CONFIG;
    render(<BridgeDeposit />);

    expect(screen.getByTestId('bridge-deposit-screen')).toHaveAttribute('data-relay', RELAY);
    expect(screen.queryByTestId('near-deposit-flow')).not.toBeInTheDocument();
  });
});

describe('BridgeDeposit: NEAR Intents alone', () => {
  beforeEach(() => {
    mockNearConfig = NEAR_CONFIG;
  });

  it('opens the Deposit flow on NEAR Intents when the relay is off', () => {
    render(<BridgeDeposit />);

    expect(screen.getByTestId('near-deposit-flow')).toBeInTheDocument();
    expect(screen.queryByTestId('deposit-unavailable')).not.toBeInTheDocument();
  });

  it('opens the Deposit flow on NEAR Intents when the account has no deposit address', () => {
    mockRelayOn = true;
    render(<BridgeDeposit />);

    expect(screen.getByTestId('near-deposit-flow')).toBeInTheDocument();
  });

  it('says the flow is not available, with the relay cause, when NEAR Intents has no route', () => {
    mockCatalogState = { status: 'unavailable' };
    render(<BridgeDeposit />);

    expect(screen.getByTestId('deposit-unavailable')).toHaveAttribute('data-cause', 'off');
  });
});

describe('BridgeDeposit: not available', () => {
  it('says the relay and NEAR Intents are both off, under the network banner', () => {
    render(<BridgeDeposit />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
    const notice = screen.getByTestId('deposit-unavailable');
    expect(notice).toHaveAttribute('data-cause', 'off');
    expect(notice).toHaveTextContent('depositFlowUnavailableTitle');
    expect(notice).toHaveTextContent('depositFlowUnavailableOff');
    expect(screen.queryByText('bridgeConnectWalletAction')).not.toBeInTheDocument();
    expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[deposit]'))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[deposit] the Deposit flow is not available:', 'off');
  });

  it('says the account has no deposit address when the relay is on', () => {
    mockRelayOn = true;
    render(<BridgeDeposit />);

    const notice = screen.getByTestId('deposit-unavailable');
    expect(notice).toHaveAttribute('data-cause', 'no-address');
    expect(notice).toHaveTextContent('depositFlowUnavailableNoAddress');
    expect(warn).toHaveBeenCalledWith('[deposit] the Deposit flow is not available:', 'no-address');
  });

  it('leaves with Done and goes Home with the close', () => {
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(createLocationState()).toMatchObject({ pathname: '/', trigger: HistoryAction.Replace });

    navigate('/bridge/deposit', HistoryAction.Replace);
    cleanup();
    render(<BridgeDeposit />);
    fireEvent.click(screen.getByTestId('flow-close'));
    expect(createLocationState()).toMatchObject({ pathname: '/' });
  });
});
