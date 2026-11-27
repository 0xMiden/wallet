import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { RelayServiceState } from 'lib/evm-relay/use-relay-service';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { createLocationState, HistoryAction, navigate, resetHistoryPosition } from 'lib/woozie';

import { BridgeDeposit } from './BridgeDeposit';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
// The network the USDCx route reads: on testnet that route keeps the entry open on its own.
let mockEffectiveNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => (mockEffectiveNetwork === 'mainnet' ? null : 'testnet'),
  getEffectiveNetworkName: () => mockEffectiveNetwork
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: jest.fn() }),
  useDisconnect: () => ({ disconnect: () => mockDisconnect() })
}));
let mockDisconnect: jest.Mock = jest.fn();

let mockConnectionError: string | null = null;
let mockConnection: { address: string | undefined; connected: boolean } = { address: undefined, connected: false };
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    ...mockConnection,
    status: 'idle',
    nativeReown: { error: mockConnectionError },
    useNativeReownWallet: false
  })
}));

let mockOpenConnectModal: jest.Mock = jest.fn();
jest.mock('lib/walletconnect/appkit', () => ({
  prepareAppKitConnection: jest.fn(async () => undefined),
  openConnectModal: () => mockOpenConnectModal()
}));

jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { currentAccount: { publicKey: string } }) => unknown) =>
    select({ currentAccount: { publicKey: 'miden-account' } })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'usdcx' }));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

let mockUsdcxDepositAvailable = false;
let mockBridgeIn: FeatureAvailability = { state: 'available' };
const mockAnyFeatureAvailability = jest.fn(
  (features: readonly string[], _options?: { hold?: boolean }): FeatureAvailability =>
    features.join() === 'fastBridgeIn,bridgeIn,usdcxDeposit'
      ? mockUsdcxDepositAvailable
        ? { state: 'available' }
        : mockBridgeIn
      : { state: 'loading' }
);
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useAnyFeatureAvailability: (features: readonly string[], options?: { hold?: boolean }) =>
    mockAnyFeatureAvailability(features, options),
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
// The relay service (`GET /v1/chains`): it serves the one chain of the relay token below, unless a case says otherwise.
let mockService: RelayServiceState = {
  status: 'ready',
  service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
};
jest.mock('lib/evm-relay/use-relay-service', () => ({
  useRelayService: (enabled: boolean) => (enabled ? mockService : { status: 'off' })
}));
jest.mock('app/templates/EvmConnectModal/relay-token-choices', () => ({
  ...jest.requireActual('app/templates/EvmConnectModal/relay-token-choices'),
  depositSourceNetworks: () => [],
  relayTokenChoices: () => [
    {
      option: {
        id: '1:ETH',
        symbol: 'ETH',
        receivedSymbol: 'ETH',
        logoFaucetId: undefined,
        network: { id: 'ethereum', name: 'Ethereum' }
      },
      chainId: 1,
      token: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      routes: ['agglayer']
    }
  ]
}));

jest.mock('components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}));

jest.mock('app/templates/EvmConnectModal/EvmBridgeDepositScreen', () => ({
  EvmBridgeDepositScreen: ({
    evmAddress,
    relaySource,
    pendingDepositId,
    onClose,
    onExit,
    onConnectAnother
  }: {
    evmAddress: string;
    relaySource?: { address: string };
    pendingDepositId?: string;
    onClose: () => void;
    onExit?: () => void;
    onConnectAnother?: () => void;
  }) => (
    <div
      data-testid="bridge-deposit-screen"
      data-source={evmAddress}
      data-relay={relaySource?.address ?? 'none'}
      data-pending={pendingDepositId ?? 'none'}
    >
      <button type="button" onClick={onConnectAnother}>
        switch
      </button>
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
  IconName: { WarningFill: 'WarningFill' }
}));

describe('BridgeDeposit (#875)', () => {
  beforeEach(() => {
    mockConnection = { address: undefined, connected: false };
    mockBridgeIn = { state: 'available' };
    mockUsdcxDepositAvailable = false;
    mockEffectiveNetwork = 'testnet';
    navigate('/bridge/deposit', HistoryAction.Replace);
    resetHistoryPosition();
  });

  // The NOT-YET-CONNECTED prompt. `beforeEach` sets `connected: false`, and this suite stubs
  // EvmBridgeDepositScreen, so this case covers only that prompt - the connected flow that
  // actually commits is EvmBridgeDepositScreen's own shell, registered in the banner registry.
  // Named honestly because the first version of this test claimed to cover the committing screen
  // and asserted against the one that commits nothing.
  it('names the network on the connect-your-wallet prompt', () => {
    render(<BridgeDeposit />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });

  it('keeps the active bridge step number legible on the receive tint', () => {
    render(<BridgeDeposit />);

    const currentStep = screen.getByText('1').parentElement;
    const nextStep = screen.getByText('2').parentElement;
    expect(currentStep).toHaveClass('bg-accent-receive-tint', 'text-accent-receive-ink');
    expect(nextStep).not.toHaveClass('bg-accent-receive-tint', 'text-accent-receive-ink');
  });

  it.each([
    { origin: '/', connected: false },
    { origin: '/receive', connected: false },
    { origin: '/', connected: true },
    { origin: '/receive', connected: true }
  ])('returns to $origin on back with connected=$connected', async ({ origin, connected }) => {
    mockConnection = connected ? { address: '0xabc', connected: true } : { address: undefined, connected: false };
    navigate(origin, HistoryAction.Replace);
    navigate('/bridge/deposit');

    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    await waitFor(() => expect(createLocationState().pathname).toBe(origin));
    expect(createLocationState()).toMatchObject({ trigger: HistoryAction.Pop, historyPosition: 0 });
  });

  it('returns a deposit opened without history to Home without adding a history entry', () => {
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(createLocationState()).toMatchObject({
      pathname: '/',
      trigger: HistoryAction.Replace,
      historyPosition: 0
    });
  });

  it('uses an explicit close handler when provided', () => {
    const onClose = jest.fn();
    render(<BridgeDeposit onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createLocationState().pathname).toBe('/bridge/deposit');
  });

  it('warns to connect a test wallet only while no EVM wallet is connected', () => {
    render(<BridgeDeposit />);

    const warning = screen.getByTestId('evm-connect-test-wallet-warning');
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'caution');
    expect(warning.querySelector('[data-slot="title"]')?.textContent).toBe('evmConnectTestWalletTitle');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('bridgeConnectTestWalletBody');
  });

  it('shows no test-wallet warning on mainnet, where the funds are real', () => {
    mockEffectiveNetwork = 'mainnet';
    render(<BridgeDeposit />);

    // The title heads the page and names step 1.
    expect(screen.getAllByText('bridgeConnectWalletTitle')).toHaveLength(2);
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
  });

  it('opens a wallet while a bridge-in route can start', () => {
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'bridgeConnectWalletAction' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });

  // Off testnet there is no USDCx route, so the Fast and Slow routes alone decide.
  it('greys out Open wallet under the notice while neither bridge-in route can start', () => {
    mockEffectiveNetwork = 'devnet';
    mockBridgeIn = { state: 'unavailable', reason: 'not-deployed', detail: 'l1Bridge has no code' };
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'bridgeConnectWalletAction' })).toBeDisabled();
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableTitle');
  });

  // A configured USDCx route keeps the entry open when the other routes are unavailable.
  it('keeps Open wallet enabled on testnet while the Fast and Slow routes cannot start', () => {
    mockUsdcxDepositAvailable = true;
    mockBridgeIn = { state: 'unavailable', reason: 'not-deployed', detail: 'l1Bridge has no code' };
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'bridgeConnectWalletAction' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
    expect(mockAnyFeatureAvailability).toHaveBeenLastCalledWith(['fastBridgeIn', 'bridgeIn', 'usdcxDeposit'], {
      hold: true
    });
  });

  // The connected branch hands the page to the deposit screen, which holds for its own greyed-out routes.
  it.each([
    ['while no wallet is connected', false, true],
    ['once a wallet is connected', true, false]
  ])('asks for the fast-poll hold only where it draws the notice: %s', (_when, connected, hold) => {
    mockConnection = connected ? { address: '0xabc', connected: true } : { address: undefined, connected: false };
    mockEffectiveNetwork = 'devnet';
    mockBridgeIn = { state: 'unavailable', reason: 'not-deployed', detail: 'l1Bridge has no code' };

    render(<BridgeDeposit />);

    expect(screen.queryByTestId('feature-unavailable-notice') !== null).toBe(hold);
    expect(mockAnyFeatureAvailability).toHaveBeenLastCalledWith(['fastBridgeIn', 'bridgeIn', 'usdcxDeposit'], { hold });
  });

  it('hands a connected wallet to the deposit screen, whose form carries its own warning', () => {
    mockConnection = { address: '0xabc', connected: true };

    render(<BridgeDeposit />);

    expect(screen.getByTestId('bridge-deposit-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
  });
});

it('reports a displayed wallet connection failure after 1000 ms without its text', async () => {
  jest.useFakeTimers();
  mockConnectionError = 'private connection failure';
  mockConnection = { address: undefined, connected: false };
  jest.mocked(reportUserVisibleError).mockClear();
  try {
    render(<BridgeDeposit />);
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(reportUserVisibleError).toHaveBeenCalledWith('raw_bridge_connect_failed', 'notice');
  } finally {
    mockConnectionError = null;
    jest.useRealTimers();
  }
});

describe('BridgeDeposit web connect failure (#2109)', () => {
  beforeEach(() => {
    mockConnection = { address: undefined, connected: false };
    mockBridgeIn = { state: 'available' };
    mockOpenConnectModal = jest.fn();
    mockDisconnect = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the failure when the connect modal cannot open instead of leaving the button dead', async () => {
    mockOpenConnectModal = jest.fn().mockRejectedValue(new Error('WalletConnect relay unreachable'));
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'bridgeConnectWalletAction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('WalletConnect relay unreachable');
  });

  it('clears the failure on the next attempt that opens', async () => {
    mockOpenConnectModal = jest.fn().mockRejectedValueOnce(new Error('first failure')).mockResolvedValue(undefined);
    render(<BridgeDeposit />);
    const connect = screen.getByRole('button', { name: 'bridgeConnectWalletAction' });

    fireEvent.click(connect);
    expect(await screen.findByRole('alert')).toHaveTextContent('first failure');
    fireEvent.click(connect);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows a localized fallback when the failure carries no message', async () => {
    mockOpenConnectModal = jest.fn().mockRejectedValue('refused');
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'bridgeConnectWalletAction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('bridgeConnectPickerFailed');
  });

  it('shows the failure when switching wallets cannot reopen the picker', async () => {
    mockConnection = { address: '0xabc', connected: true };
    mockDisconnect = jest.fn(async () => {
      mockConnection = { address: undefined, connected: false };
    });
    mockOpenConnectModal = jest.fn().mockRejectedValue(new Error('picker refused'));
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('picker refused');
  });
});

describe('BridgeDeposit: the relay serves the account', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    mockService = {
      status: 'ready',
      service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
    };
    mockRelayOn = true;
    mockRelaySource = { accountPublicKey: 'miden-account', address: RELAY };
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    navigate('/bridge/deposit', HistoryAction.Replace);
    resetHistoryPosition();
  });
  afterEach(() => {
    warn.mockRestore();
    mockRelayOn = false;
    mockRelaySource = null;
  });

  it('opens the deposit screen on the relay address, with no connect step', () => {
    render(<BridgeDeposit />);

    const depositScreen = screen.getByTestId('bridge-deposit-screen');
    expect(depositScreen).toHaveAttribute('data-source', RELAY);
    expect(depositScreen).toHaveAttribute('data-relay', RELAY);
    expect(screen.queryByText('bridgeConnectWalletAction')).not.toBeInTheDocument();
  });

  it('names no pending deposit without the query, and leaves for Home from the close', () => {
    render(<BridgeDeposit />);

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

  it('says the deposit service cannot be reached when NEAR Intents is off too', () => {
    mockService = { status: 'unreachable', error: new Error('relay (404 not_found)') };
    render(<BridgeDeposit />);

    const notice = screen.getByTestId('deposit-unavailable');
    expect(notice).toHaveAttribute('data-cause', 'unreachable');
    expect(notice).toHaveTextContent('depositFlowUnavailableUnreachable');
    expect(warn).toHaveBeenCalledWith('[deposit] the Deposit flow is not available:', 'unreachable');
  });
});
