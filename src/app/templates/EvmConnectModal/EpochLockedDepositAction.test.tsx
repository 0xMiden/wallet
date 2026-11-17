import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { IEpochLockedDeposit } from 'lib/miden/db/types';

import { EpochLockedDepositAction } from './EpochLockedDepositAction';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));
jest.mock('lib/walletconnect/config', () => ({ getChain: () => ({ name: 'Sepolia' }) }));
jest.mock('lib/walletconnect/signing-error', () => ({ nativeSigningErrorMessage: () => 'failed' }));
const mockConnection: { address: string | undefined; connected: boolean } = { address: undefined, connected: false };
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({ useEvmWalletConnection: () => mockConnection }));
const mockOpenPicker = jest.fn();
jest.mock('lib/walletconnect/useEvmWalletPicker', () => ({
  useEvmWalletPicker: () => ({ openWalletPicker: mockOpenPicker, error: undefined })
}));
jest.mock('lib/epoch/bridge-in-recovery', () => ({
  LockedDepositError: class extends Error {},
  sponsorWalletRefusal: (connected: string | undefined, sponsor: string) => {
    if (!connected) return 'walletDisconnected';
    return connected.toLowerCase() === sponsor.toLowerCase() ? undefined : 'wrongAccount';
  },
  retryLockedDeposit: jest.fn(),
  startLockedDepositWithdrawal: jest.fn(),
  finishLockedDepositWithdrawal: jest.fn()
}));

const SPONSOR = '0x00000000000000000000000000000000000000AA';
const LOCK: IEpochLockedDeposit = {
  sponsorAddress: SPONSOR,
  chainId: 11155111,
  lockId: '42',
  tokenAddress: '0x0000000000000000000000000000000000000002',
  isNative: false,
  amount: '1000000',
  taskTypeString: 'task',
  intentData: {},
  lockedAt: 1
};

const renderRow = () =>
  render(<EpochLockedDepositAction txId="row-1" lock={LOCK} state="locked" amountLabel="1 USDC" />);

beforeEach(() => {
  jest.clearAllMocks();
  mockConnection.address = undefined;
  mockConnection.connected = false;
});

describe('EpochLockedDepositAction', () => {
  it('opens the lock in the Settings recovery page', () => {
    renderRow();

    fireEvent.click(screen.getByTestId('epoch-deposit-open-recovery'));

    expect(mockNavigate).toHaveBeenCalledWith(`/settings/recover-funds/11155111/42?address=${SPONSOR}`);
  });

  it('opens the wallet picker directly to connect the sponsor', () => {
    renderRow();

    fireEvent.click(screen.getByTestId('epoch-deposit-connect'));

    expect(mockOpenPicker).toHaveBeenCalled();
    expect(screen.queryByTestId('epoch-deposit-retry')).not.toBeInTheDocument();
  });

  it('offers the recovery actions to the sponsor wallet', () => {
    mockConnection.address = SPONSOR.toLowerCase();
    mockConnection.connected = true;
    renderRow();

    expect(screen.getByTestId('epoch-deposit-retry')).toBeInTheDocument();
    expect(screen.getByTestId('epoch-deposit-withdraw')).toBeInTheDocument();
  });

  it('keeps the countdown moving when a render lands between the deadline and the next tick', () => {
    jest.useFakeTimers();
    try {
      const startMs = 1_700_000_000_000;
      jest.setSystemTime(startMs);
      mockConnection.address = SPONSOR.toLowerCase();
      mockConnection.connected = true;
      const lock: IEpochLockedDeposit = {
        ...LOCK,
        withdrawEnabledAt: startMs / 1000 - 10,
        withdrawableAt: startMs / 1000 + 2
      };
      // A new element for each render: React skips a render of the same element.
      const row = () => <EpochLockedDepositAction txId="row-1" lock={lock} state="locked" amountLabel="1 USDC" />;
      const view = render(row());
      expect(screen.getByTestId('epoch-deposit-withdraw')).toBeDisabled();

      // The deadline passes, and a render occurs before the interval fires.
      jest.setSystemTime(startMs + 5_000);
      view.rerender(row());
      act(() => {
        jest.advanceTimersByTime(1_000);
      });

      expect(screen.getByTestId('epoch-deposit-withdraw')).toBeEnabled();
      expect(screen.getByTestId('epoch-deposit-withdraw-status')).toHaveTextContent('epochDepositWithdrawReady');
    } finally {
      jest.useRealTimers();
    }
  });
});
