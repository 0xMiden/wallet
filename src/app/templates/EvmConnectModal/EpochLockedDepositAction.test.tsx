import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  finishLockedDepositWithdrawal,
  retryLockedDeposit,
  startLockedDepositWithdrawal
} from 'lib/epoch/bridge-in-recovery';
import type { IEpochLockedDeposit } from 'lib/miden/db/types';

import { EpochLockedDepositAction } from './EpochLockedDepositAction';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));
jest.mock('lib/walletconnect/config', () => ({ getChain: () => ({ name: 'Sepolia' }) }));
jest.mock('lib/walletconnect/signing-error', () => ({
  nativeSigningErrorMessage: () => 'failed',
  nativeSigningErrorId: () => undefined
}));
const mockReportError = jest.fn();
jest.mock('lib/telemetry/use-user-visible-error', () => ({
  useUserVisibleError: (...args: unknown[]) => mockReportError(...args)
}));
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

  describe('as the sponsor wallet', () => {
    // A new element for each render: React skips a render of the same element.
    const sponsorRow = (lock: IEpochLockedDeposit, state: 'locked' | 'withdrawn' = 'locked') => (
      <EpochLockedDepositAction txId="row-1" lock={lock} state={state} amountLabel="1 USDC" />
    );

    beforeEach(() => {
      mockConnection.address = SPONSOR.toLowerCase();
      mockConnection.connected = true;
      jest.mocked(retryLockedDeposit).mockResolvedValue('77');
      jest.mocked(startLockedDepositWithdrawal).mockResolvedValue(undefined);
      jest.mocked(finishLockedDepositWithdrawal).mockResolvedValue('0xwithdraw');
    });

    it('retries the row that was clicked', async () => {
      render(sponsorRow(LOCK));

      fireEvent.click(screen.getByTestId('epoch-deposit-retry'));

      await waitFor(() => expect(screen.getByTestId('epoch-deposit-retry')).toBeEnabled());
      expect(retryLockedDeposit).toHaveBeenCalledTimes(1);
      expect(retryLockedDeposit).toHaveBeenCalledWith('row-1');
      expect(startLockedDepositWithdrawal).not.toHaveBeenCalled();
      expect(finishLockedDepositWithdrawal).not.toHaveBeenCalled();
    });

    it('starts the withdrawal with no recorded enable time, then finishes it once the time is recorded', async () => {
      const view = render(sponsorRow(LOCK));

      fireEvent.click(screen.getByTestId('epoch-deposit-withdraw'));
      await waitFor(() => expect(screen.getByTestId('epoch-deposit-withdraw')).toBeEnabled());
      expect(startLockedDepositWithdrawal).toHaveBeenCalledTimes(1);
      expect(startLockedDepositWithdrawal).toHaveBeenCalledWith('row-1');
      expect(finishLockedDepositWithdrawal).not.toHaveBeenCalled();

      const enabledAt = Math.floor(Date.now() / 1000) - 100;
      view.rerender(sponsorRow({ ...LOCK, withdrawEnabledAt: enabledAt, withdrawableAt: enabledAt + 50 }));
      fireEvent.click(screen.getByTestId('epoch-deposit-withdraw'));
      await waitFor(() => expect(screen.getByTestId('epoch-deposit-withdraw')).toBeEnabled());
      expect(finishLockedDepositWithdrawal).toHaveBeenCalledTimes(1);
      expect(finishLockedDepositWithdrawal).toHaveBeenCalledWith('row-1');
      expect(startLockedDepositWithdrawal).toHaveBeenCalledTimes(1);
    });

    it('disables Withdraw while the countdown is positive', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      render(sponsorRow({ ...LOCK, withdrawEnabledAt: nowSeconds - 10, withdrawableAt: nowSeconds + 3600 }));

      const withdraw = screen.getByTestId('epoch-deposit-withdraw');
      expect(withdraw).toBeDisabled();
      expect(screen.getByTestId('epoch-deposit-withdraw-status')).toHaveTextContent('epochDepositWithdrawStarted');
      fireEvent.click(withdraw);

      expect(startLockedDepositWithdrawal).not.toHaveBeenCalled();
      expect(finishLockedDepositWithdrawal).not.toHaveBeenCalled();
    });

    it('shows the withdrawn text and no actions for a withdrawn row', () => {
      render(sponsorRow({ ...LOCK, withdrawnAt: 5 }, 'withdrawn'));

      expect(screen.getByTestId('epoch-deposit-withdrawn')).toHaveTextContent('epochDepositWithdrawnBody');
      expect(screen.queryByTestId('epoch-deposit-retry')).not.toBeInTheDocument();
      expect(screen.queryByTestId('epoch-deposit-withdraw')).not.toBeInTheDocument();
    });

    it('shows the error line when an action is rejected', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        jest.mocked(retryLockedDeposit).mockRejectedValueOnce(new Error('Wallet refused'));
        render(sponsorRow(LOCK));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(mockReportError).not.toHaveBeenCalledWith('raw_bridge_deposit_failed', 'inline');

        fireEvent.click(screen.getByTestId('epoch-deposit-retry'));

        expect(await screen.findByRole('alert')).toHaveTextContent('failed');
        // The alert paragraph is reported under the id of a failed bridge deposit recovery.
        expect(mockReportError).toHaveBeenCalledWith('raw_bridge_deposit_failed', 'inline');
        expect(screen.getByTestId('epoch-deposit-retry')).toBeEnabled();
      } finally {
        consoleError.mockRestore();
      }
    });
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

  it('enables Withdraw immediately when an expired deadline arrives asynchronously while no timer was running', () => {
    jest.useFakeTimers();
    try {
      const startMs = 1_700_000_000_000;
      jest.setSystemTime(startMs);
      mockConnection.address = SPONSOR.toLowerCase();
      mockConnection.connected = true;
      const view = render(<EpochLockedDepositAction txId="row-1" lock={LOCK} state="locked" amountLabel="1 USDC" />);
      expect(jest.getTimerCount()).toBe(0);

      jest.setSystemTime(startMs + 5_000);
      view.rerender(
        <EpochLockedDepositAction
          txId="row-1"
          lock={{ ...LOCK, withdrawEnabledAt: startMs / 1000 - 10, withdrawableAt: startMs / 1000 + 2 }}
          state="locked"
          amountLabel="1 USDC"
        />
      );

      expect(jest.getTimerCount()).toBe(0);
      expect(screen.getByTestId('epoch-deposit-withdraw')).toBeEnabled();
      expect(screen.getByTestId('epoch-deposit-withdraw-status')).toHaveTextContent('epochDepositWithdrawReady');
    } finally {
      jest.useRealTimers();
    }
  });
});
