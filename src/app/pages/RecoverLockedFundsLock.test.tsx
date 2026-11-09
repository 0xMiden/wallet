import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import RecoverLockedFundsLock from './RecoverLockedFundsLock';

// Echo the key, and the parameters when there are some, so the copy is assertable without the catalog.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

const SPONSOR = '0x00000000000000000000000000000000000000AA';
const OTHER = '0x00000000000000000000000000000000000000bb';
const LOCK_ID = '42';
const REF = { chainId: 11155111, lockId: LOCK_ID, sponsorAddress: SPONSOR };

const mockLocation = { search: `?address=${SPONSOR}` };
jest.mock('lib/woozie', () => ({ useLocation: () => mockLocation }));
const mockBack = jest.fn();
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => mockBack }));

const mockConnection: { address: string | undefined; connected: boolean } = { address: SPONSOR, connected: true };
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({ useEvmWalletConnection: () => mockConnection }));
const mockOpenPicker = jest.fn();
jest.mock('lib/walletconnect/useEvmWalletPicker', () => ({
  useEvmWalletPicker: () => ({ openWalletPicker: mockOpenPicker, error: undefined })
}));
jest.mock('lib/walletconnect/config', () => ({ getChain: () => ({ name: 'Sepolia' }) }));
jest.mock('lib/walletconnect/signing-error', () => ({
  nativeSigningErrorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
}));

jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectEpochTokens: () => [
    {
      key: 'USDC',
      address: '0x0000000000000000000000000000000000000002',
      chainId: 11155111,
      symbol: 'USDC',
      decimals: 6
    }
  ]
}));

const mockReadState = jest.fn();
jest.mock('lib/epoch/bridge-in-lock-scan', () => ({
  compactLockToken: () => '0x0000000000000000000000000000000000000002',
  readCompactLockState: (...args: unknown[]) => mockReadState(...args)
}));

const mockReadRecord = jest.fn();
jest.mock('lib/epoch/forced-withdrawal-record', () => ({
  readForcedWithdrawalRecord: (...args: unknown[]) => mockReadRecord(...args)
}));

const mockStart = jest.fn();
const mockFinish = jest.fn();
const mockCancel = jest.fn();
const mockRetry = jest.fn();
const mockFindRetryable = jest.fn();
const mockDepositsOnLock = jest.fn();
jest.mock('lib/epoch/bridge-in-recovery', () => {
  class LockedDepositError extends Error {
    constructor(
      readonly reason: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    LockedDepositError,
    sponsorWalletRefusal: (connected: string | undefined, sponsor: string) => {
      if (!connected) return 'walletDisconnected';
      return connected.toLowerCase() === sponsor.toLowerCase() ? undefined : 'wrongAccount';
    },
    startLockWithdrawal: (...args: unknown[]) => mockStart(...args),
    finishLockWithdrawal: (...args: unknown[]) => mockFinish(...args),
    cancelLockWithdrawal: (...args: unknown[]) => mockCancel(...args),
    retryLockedDeposit: (...args: unknown[]) => mockRetry(...args),
    findRetryableLockedDeposit: (...args: unknown[]) => mockFindRetryable(...args),
    lockedDepositsOnLock: (...args: unknown[]) => mockDepositsOnLock(...args)
  };
});

async function renderLock(chainId = '11155111', lockId = LOCK_ID) {
  render(<RecoverLockedFundsLock chainId={chainId} lockId={lockId} />);
  // Let the reads settle.
  await act(async () => undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  mockLocation.search = `?address=${SPONSOR}`;
  mockConnection.address = SPONSOR;
  mockConnection.connected = true;
  mockReadState.mockResolvedValue({ balance: 2_500_000n, withdrawal: { status: 'Disabled' } });
  mockReadRecord.mockResolvedValue(undefined);
  mockFindRetryable.mockResolvedValue(undefined);
  mockDepositsOnLock.mockResolvedValue([]);
  mockStart.mockResolvedValue(4900);
  mockFinish.mockResolvedValue('0xwithdraw');
  mockCancel.mockResolvedValue(undefined);
  mockRetry.mockResolvedValue('77');
});
afterEach(() => jest.restoreAllMocks());

describe('RecoverLockedFundsLock', () => {
  it('shows the lock and starts the forced withdrawal for the sponsor', async () => {
    await renderLock();

    expect(mockReadState).toHaveBeenCalledWith(11155111, SPONSOR, 42n);
    expect(screen.getByTestId('recover-funds-lock-balance')).toHaveTextContent('2.5 USDC');
    expect(screen.getByTestId('recover-funds-lock-status')).toHaveTextContent('recoverFundsWithdrawOff');
    expect(screen.getByText(/recoverFundsWithdrawBlocksBridge/)).toBeInTheDocument();
    expect(screen.queryByTestId('recover-funds-lock-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recover-funds-lock-cancel')).not.toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByTestId('recover-funds-lock-withdraw')));

    expect(mockStart).toHaveBeenCalledWith(REF);
    expect(mockFinish).not.toHaveBeenCalled();
    // The action asks for a fresh read of the lock.
    expect(mockReadState).toHaveBeenCalledTimes(2);
  });

  it('counts down a pending withdrawal from the chain, and cancels it', async () => {
    mockReadState.mockResolvedValue({ balance: 1n, withdrawal: { status: 'Pending', withdrawableAt: 1065 } });
    await renderLock();

    expect(screen.getByTestId('recover-funds-lock-status')).toHaveTextContent(
      'epochDepositWithdrawStarted:{"time":"1:05"}'
    );
    expect(screen.getByTestId('recover-funds-lock-withdraw')).toBeDisabled();

    await act(async () => fireEvent.click(screen.getByTestId('recover-funds-lock-cancel')));
    expect(mockCancel).toHaveBeenCalledWith(REF);
  });

  it('withdraws the whole lock once the withdrawal is due', async () => {
    mockReadState.mockResolvedValue({ balance: 1n, withdrawal: { status: 'Enabled', withdrawableAt: 900 } });
    await renderLock();

    expect(screen.getByTestId('recover-funds-lock-status')).toHaveTextContent('epochDepositWithdrawReady');
    await act(async () => fireEvent.click(screen.getByTestId('recover-funds-lock-withdraw')));
    expect(mockFinish).toHaveBeenCalledWith(REF);
  });

  it('uses the recorded enable time when The Compact does not answer', async () => {
    mockReadState.mockResolvedValue({});
    mockReadRecord.mockResolvedValue({ enabledAt: 990, withdrawableAt: 1010 });
    await renderLock();

    expect(screen.getByTestId('recover-funds-lock-balance')).toHaveTextContent('recoverFundsCouldNotCheckShort');
    expect(screen.getByTestId('recover-funds-lock-status')).toHaveTextContent(
      'epochDepositWithdrawStarted:{"time":"0:10"}'
    );
  });

  it('prefers a locked history row over the storage record', async () => {
    mockReadState.mockResolvedValue({});
    mockDepositsOnLock.mockResolvedValue([{ id: 'row-1', lock: { withdrawEnabledAt: 950, withdrawableAt: 1030 } }]);
    mockReadRecord.mockResolvedValue({ enabledAt: 990, withdrawableAt: 1010 });
    await renderLock();

    expect(screen.getByTestId('recover-funds-lock-status')).toHaveTextContent('"time":"0:30"');
  });

  it('offers Retry bridge only when a row still holds the intent', async () => {
    mockFindRetryable.mockResolvedValue('row-1');
    await renderLock();

    await act(async () => fireEvent.click(screen.getByTestId('recover-funds-lock-retry')));
    expect(mockRetry).toHaveBeenCalledWith('row-1');
  });

  it('asks for the sponsor wallet when none is connected', async () => {
    mockConnection.connected = false;
    mockConnection.address = undefined;
    await renderLock();

    expect(screen.queryByTestId('recover-funds-lock-withdraw')).not.toBeInTheDocument();
    expect(screen.getByText(/epochDepositConnectSponsor/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recover-funds-lock-connect'));
    expect(mockOpenPicker).toHaveBeenCalled();
    expect(screen.getByTestId('recover-funds-lock-connect')).toHaveTextContent('connectEvmWallet');
  });

  it('refuses another wallet with the wrong-wallet text', async () => {
    mockConnection.address = OTHER;
    await renderLock();

    expect(screen.queryByTestId('recover-funds-lock-withdraw')).not.toBeInTheDocument();
    expect(screen.getByText(/epochDepositWrongWallet/)).toBeInTheDocument();
    expect(screen.getByTestId('recover-funds-lock-connect')).toHaveTextContent('switchWallet');
  });

  it('shows the refusal of an action', async () => {
    const { LockedDepositError } = jest.requireMock('lib/epoch/bridge-in-recovery');
    mockStart.mockRejectedValue(new LockedDepositError('wrongChain', 'switch'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderLock();

    await act(async () => fireEvent.click(screen.getByTestId('recover-funds-lock-withdraw')));

    expect(screen.getByTestId('recover-funds-lock-error')).toHaveTextContent('epochDepositErrorWrongChain');
  });

  it('has nothing to do on an empty lock', async () => {
    mockReadState.mockResolvedValue({ balance: 0n, withdrawal: { status: 'Disabled' } });
    await renderLock();

    expect(screen.getByTestId('recover-funds-lock-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('recover-funds-lock-withdraw')).not.toBeInTheDocument();
  });

  it('refuses a link with a bad lock id or address', async () => {
    mockLocation.search = '?address=nope';
    await renderLock();
    expect(screen.getByTestId('recover-funds-lock-invalid')).toBeInTheDocument();
    expect(mockReadState).not.toHaveBeenCalled();
  });
});
