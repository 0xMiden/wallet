import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { BridgeDeposit } from './BridgeDeposit';

// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
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

jest.mock('components/ui/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
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
    expect(warning).toHaveTextContent('evmConnectTestWalletTitle');
    expect(warning).toHaveTextContent('evmConnectTestWalletBody');
  });

  it('hands a connected wallet to the deposit screen, whose form carries its own warning', () => {
    mockConnection = { address: '0xabc', connected: true };

    render(<BridgeDeposit />);

    expect(screen.getByTestId('bridge-deposit-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('evm-connect-test-wallet-warning')).not.toBeInTheDocument();
  });
});
