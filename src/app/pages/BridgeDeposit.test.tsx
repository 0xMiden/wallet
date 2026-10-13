import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { BridgeDeposit } from './BridgeDeposit';

// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet',
  getEffectiveNetworkName: () => 'testnet'
}));

// The bridge config snapshot the entry reads. The document decides which bridge-in routes can start.
// `mockHoldFastPoll` records each fast-poll hold the page takes.
let mockBridgeSnapshot: BridgeConfigSnapshot;
const mockHoldFastPoll = jest.fn();
jest.mock('lib/remote-config/runtime', () => ({
  ...jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot),
  holdFastPoll: () => {
    mockHoldFastPoll();
    return () => undefined;
  }
}));

/** The testnet snapshot with other feature switches. Its document names no Agglayer bridge, so Slow never starts. */
const snapshotWith = (features: Partial<typeof TEST_BRIDGE_CONFIG.features>): BridgeConfigSnapshot => ({
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: { ...TEST_BRIDGE_CONFIG, features: { ...TEST_BRIDGE_CONFIG.features, ...features } }
});
/** No bridge-in route can start: Fast and USDCx are switched off. */
const NO_ROUTE_SNAPSHOT = snapshotWith({ fastBridge: false, usdcxIn: false });
/** Only the USDCx route can start. */
const USDCX_ONLY_SNAPSHOT = snapshotWith({ fastBridge: false });
/** The document has no `usdcx` section, and the Fast route can start. */
const NO_USDCX_SNAPSHOT: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: { ...TEST_BRIDGE_CONFIG, usdcx: undefined }
};
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: jest.fn() }),
  useDisconnect: () => ({ disconnect: jest.fn() })
}));

let mockConnection: { address: string | undefined; connected: boolean } = { address: undefined, connected: false };
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    ...mockConnection,
    status: 'idle',
    nativeReown: { error: null },
    useNativeReownWallet: false
  })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (select: (state: { currentAccount: { publicKey: string } }) => unknown) =>
    select({ currentAccount: { publicKey: 'miden-account' } })
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));

jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));

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

jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
    <div>
      {title}
      <button type="button" aria-label="close" onClick={onClose}>
        close
      </button>
    </div>
  )
}));

jest.mock('app/templates/EvmConnectModal/EvmBridgeDepositScreen', () => ({
  EvmBridgeDepositScreen: () => <div data-testid="bridge-deposit-screen" />
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('BridgeDeposit (#875)', () => {
  beforeEach(() => {
    mockConnection = { address: undefined, connected: false };
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    mockHoldFastPoll.mockClear();
    mockNavigate.mockClear();
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

  it('closes via the header, falling back to /receive with no onClose prop', () => {
    render(<BridgeDeposit />);

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(mockNavigate).toHaveBeenCalledWith('/receive');
  });

  it('warns to connect a test wallet only while no EVM wallet is connected', () => {
    render(<BridgeDeposit />);

    const warning = screen.getByTestId('evm-connect-test-wallet-warning');
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning.querySelector('[data-slot="title"]')?.textContent).toBe('evmConnectTestWalletTitle');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('evmConnectTestWalletBody');
  });

  it('opens a wallet while a bridge-in route can start', () => {
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });

  // The USDCx route is off and the Fast and Slow routes cannot start, so no route is left.
  it('greys out Open wallet under the notice while no bridge-in route can start', () => {
    mockBridgeSnapshot = NO_ROUTE_SNAPSHOT;
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeDisabled();
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableTitle');
  });

  // The document lists the USDCx route and its switch is on, so that route keeps the entry open on its own
  // and the page holds no fast poll.
  it('keeps Open wallet enabled while the document offers USDCx and the Fast and Slow routes cannot start', () => {
    mockBridgeSnapshot = USDCX_ONLY_SNAPSHOT;
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
    expect(mockHoldFastPoll).not.toHaveBeenCalled();
  });

  // The opposite case: a document with no `usdcx` section leaves the entry to the Fast and Slow routes.
  it('keeps Open wallet enabled on the Fast route while the document has no usdcx section', () => {
    mockBridgeSnapshot = NO_USDCX_SNAPSHOT;
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });

  it('greys out Open wallet while the document has no usdcx section and the Fast and Slow routes cannot start', () => {
    mockBridgeSnapshot = {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...TEST_BRIDGE_CONFIG,
        features: { ...TEST_BRIDGE_CONFIG.features, fastBridge: false },
        usdcx: undefined
      }
    };
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeDisabled();
    expect(screen.getByTestId('feature-unavailable-notice')).toBeInTheDocument();
  });

  // The connected branch hands the page to the deposit screen, which holds for its own greyed-out routes.
  it.each([
    ['while no wallet is connected', false, true],
    ['once a wallet is connected', true, false]
  ])('asks for the fast-poll hold only where it draws the notice: %s', (_when, connected, hold) => {
    mockConnection = connected ? { address: '0xabc', connected: true } : { address: undefined, connected: false };
    mockBridgeSnapshot = NO_ROUTE_SNAPSHOT;

    render(<BridgeDeposit />);

    expect(screen.queryByTestId('feature-unavailable-notice') !== null).toBe(hold);
    expect(mockHoldFastPoll).toHaveBeenCalledTimes(hold ? 1 : 0);
  });

  it('hands a connected wallet to the deposit screen, whose form carries its own warning', () => {
    mockConnection = { address: '0xabc', connected: true };

    render(<BridgeDeposit />);

    expect(screen.getByTestId('bridge-deposit-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
  });
});
