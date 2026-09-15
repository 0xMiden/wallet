import React from 'react';

import { render, screen } from '@testing-library/react';

import { BridgeDeposit } from './BridgeDeposit';

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

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

jest.mock('lib/mobile/haptics', () => ({ hapticMedium: jest.fn() }));

jest.mock('lib/ui/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}));

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title }: { title: string }) => <div>{title}</div>
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
