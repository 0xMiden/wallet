import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { FeatureAvailability } from 'lib/remote-config/availability';

import { BridgeDeposit } from './BridgeDeposit';

// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
// The network the USDCx route reads: on testnet that route keeps the entry open on its own.
let mockEffectiveNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet',
  getEffectiveNetworkName: () => mockEffectiveNetwork
}));
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

let mockBridgeIn: FeatureAvailability = { state: 'available' };
const mockAnyFeatureAvailability = jest.fn(
  (features: readonly string[], _options?: { hold?: boolean }): FeatureAvailability =>
    features.join() === 'fastBridgeIn,bridgeIn' ? mockBridgeIn : { state: 'loading' }
);
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useAnyFeatureAvailability: (features: readonly string[], options?: { hold?: boolean }) =>
    mockAnyFeatureAvailability(features, options)
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
    mockBridgeIn = { state: 'available' };
    mockEffectiveNetwork = 'testnet';
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

  // Off testnet there is no USDCx route, so the Fast and Slow routes alone decide.
  it('greys out Open wallet under the notice while neither bridge-in route can start', () => {
    mockEffectiveNetwork = 'devnet';
    mockBridgeIn = { state: 'unavailable', reason: 'not-deployed', detail: 'l1Bridge has no code' };
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeDisabled();
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableTitle');
  });

  // The USDCx route reads no bridge config, so on testnet it keeps the entry open and holds no fast poll.
  it('keeps Open wallet enabled on testnet while the Fast and Slow routes cannot start', () => {
    mockBridgeIn = { state: 'unavailable', reason: 'not-deployed', detail: 'l1Bridge has no code' };
    render(<BridgeDeposit />);

    expect(screen.getByRole('button', { name: 'openWallet' })).toBeEnabled();
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
    expect(mockAnyFeatureAvailability).toHaveBeenLastCalledWith(['fastBridgeIn', 'bridgeIn'], { hold: false });
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
    expect(mockAnyFeatureAvailability).toHaveBeenLastCalledWith(['fastBridgeIn', 'bridgeIn'], { hold });
  });

  it('hands a connected wallet to the deposit screen, whose form carries its own warning', () => {
    mockConnection = { address: '0xabc', connected: true };

    render(<BridgeDeposit />);

    expect(screen.getByTestId('bridge-deposit-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
  });
});
