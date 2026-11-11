import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  compactLockId,
  readCompactLockConfig,
  readCompactLockState,
  type CompactLockState
} from 'lib/epoch/bridge-in-lock-scan';
import { cancelLockWithdrawal } from 'lib/epoch/bridge-in-recovery';
import { requestLockRescan } from 'lib/epoch/lock-scan-refresh';

import { EpochWithdrawalGate } from './EpochWithdrawalGate';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/walletconnect/config', () => ({ getChain: () => ({ name: 'Polygon' }) }));
jest.mock('lib/epoch/bridge-in-lock-scan', () => ({
  compactLockId: jest.fn(() => 42n),
  readCompactLockConfig: jest.fn(),
  readCompactLockState: jest.fn()
}));
jest.mock('lib/epoch/bridge-in-recovery', () => ({ cancelLockWithdrawal: jest.fn() }));
jest.mock('lib/epoch/lock-scan-refresh', () => ({ requestLockRescan: jest.fn() }));
jest.mock('./locked-deposit-error-text', () => ({
  lockedDepositErrorText: (cause: Error) => cause.message
}));

const SPONSOR = '0x00000000000000000000000000000000000000AA';
const TOKEN = '0x0000000000000000000000000000000000000002';
const ALLOCATOR = '0x0000000000000000000000000000000000000003';
const mockOnDisabled = jest.fn<Promise<void>, []>();
const props = {
  chainId: 137,
  tokenAddress: TOKEN,
  tokenLabel: 'USDC',
  sponsorAddress: SPONSOR,
  allocatorUrl: 'https://allocator.test',
  onDisabled: mockOnDisabled
};

const renderGate = () =>
  render(
    <EpochWithdrawalGate {...props}>
      <button>Continue bridge</button>
    </EpochWithdrawalGate>
  );

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readCompactLockConfig).mockResolvedValue({
    chainId: 137,
    compact: TOKEN,
    allocator: ALLOCATOR,
    resetPeriod: 2,
    scope: 0
  });
  jest.mocked(readCompactLockState).mockResolvedValue({ balance: 0n, withdrawal: { status: 'Disabled' } });
  jest.mocked(cancelLockWithdrawal).mockResolvedValue(undefined);
  mockOnDisabled.mockResolvedValue(undefined);
});

it('holds submission while the status read is pending, then opens a disabled lock without signing', async () => {
  let finishRead: (state: CompactLockState) => void = () => {};
  jest.mocked(readCompactLockState).mockReturnValue(
    new Promise(resolve => {
      finishRead = resolve;
    })
  );
  renderGate();

  expect(screen.queryByRole('button', { name: 'Continue bridge' })).not.toBeInTheDocument();
  expect(screen.getByTestId('bridge-withdrawal-disable')).toBeDisabled();
  await waitFor(() => expect(readCompactLockState).toHaveBeenCalledWith(137, SPONSOR, 42n));
  await act(async () => finishRead({ withdrawal: { status: 'Disabled' } }));

  expect(screen.getByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
  expect(readCompactLockConfig).toHaveBeenCalledWith(props.allocatorUrl, 137);
  expect(compactLockId).toHaveBeenCalledWith(ALLOCATOR, 2, 0, TOKEN);
  expect(cancelLockWithdrawal).not.toHaveBeenCalled();
});

it.each(['Pending', 'Enabled'])('offers cancellation for an empty lock with status %s', async status => {
  const withdrawalStatus = status === 'Pending' ? 'Pending' : 'Enabled';
  jest.mocked(readCompactLockState).mockResolvedValue({ balance: 0n, withdrawal: { status: withdrawalStatus } });
  renderGate();
  expect(await screen.findByRole('button', { name: 'bridgeWithdrawalDisable' })).toBeEnabled();
  expect(screen.getByText('bridgeWithdrawalEffect')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue bridge' })).not.toBeInTheDocument();
});

it('waits for wallet confirmation and a fresh quote before it opens the bridge', async () => {
  jest.mocked(readCompactLockState).mockResolvedValue({ withdrawal: { status: 'Enabled' } });
  let confirm: () => void = () => {};
  let quote: () => void = () => {};
  jest.mocked(cancelLockWithdrawal).mockReturnValue(
    new Promise(resolve => {
      confirm = resolve;
    })
  );
  mockOnDisabled.mockReturnValue(
    new Promise(resolve => {
      quote = resolve;
    })
  );
  renderGate();
  const disable = await screen.findByRole('button', { name: 'bridgeWithdrawalDisable' });
  fireEvent.click(disable);
  fireEvent.click(disable);

  expect(cancelLockWithdrawal).toHaveBeenCalledTimes(1);
  expect(cancelLockWithdrawal).toHaveBeenCalledWith({ chainId: 137, lockId: '42', sponsorAddress: SPONSOR });
  expect(screen.getByTestId('bridge-withdrawal-disable')).toBeDisabled();
  expect(screen.getByText('bridgeWithdrawalWalletPrompt')).toBeInTheDocument();
  expect(mockOnDisabled).not.toHaveBeenCalled();

  await act(async () => confirm());
  expect(requestLockRescan).toHaveBeenCalledTimes(1);
  expect(mockOnDisabled).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Continue bridge' })).not.toBeInTheDocument();
  await act(async () => quote());
  expect(screen.getByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
});

it('keeps the action available after the wallet rejects the transaction', async () => {
  jest.mocked(readCompactLockState).mockResolvedValue({ withdrawal: { status: 'Pending' } });
  jest.mocked(cancelLockWithdrawal).mockRejectedValueOnce(new Error('User rejected the request'));
  renderGate();
  fireEvent.click(await screen.findByRole('button', { name: 'bridgeWithdrawalDisable' }));

  expect(await screen.findByTestId('bridge-withdrawal-error')).toHaveTextContent('User rejected the request');
  expect(screen.getByTestId('bridge-withdrawal-disable')).toBeEnabled();
  expect(mockOnDisabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('bridge-withdrawal-disable'));
  expect(await screen.findByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
});

it('holds an unreadable status and can retry without a wallet transaction', async () => {
  jest.mocked(readCompactLockState).mockResolvedValueOnce({ balance: 0n });
  renderGate();
  fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
  expect(await screen.findByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
  expect(cancelLockWithdrawal).not.toHaveBeenCalled();
});

it('can retry a failed configuration read', async () => {
  jest.mocked(readCompactLockConfig).mockRejectedValueOnce(new Error('Unavailable'));
  renderGate();
  fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
  expect(await screen.findByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
});

it('ignores a status read from a lock that was replaced', async () => {
  let finishRead: (state: CompactLockState) => void = () => {};
  jest.mocked(readCompactLockState).mockReturnValueOnce(
    new Promise(resolve => {
      finishRead = resolve;
    })
  );
  const view = renderGate();
  await waitFor(() => expect(readCompactLockState).toHaveBeenCalledTimes(1));
  view.rerender(
    <EpochWithdrawalGate {...props} key="new-chain" chainId={1}>
      <button>Continue bridge</button>
    </EpochWithdrawalGate>
  );
  expect(await screen.findByRole('button', { name: 'Continue bridge' })).toBeInTheDocument();
  await act(async () => finishRead({ withdrawal: { status: 'Enabled' } }));
  expect(screen.queryByTestId('bridge-withdrawal-disable')).not.toBeInTheDocument();
  expect(readCompactLockState).toHaveBeenLastCalledWith(1, SPONSOR, 42n);
});

it('does not refresh another flow when an old wallet request completes after unmount', async () => {
  jest.mocked(readCompactLockState).mockResolvedValue({ withdrawal: { status: 'Enabled' } });
  let confirm: () => void = () => {};
  jest.mocked(cancelLockWithdrawal).mockReturnValue(
    new Promise(resolve => {
      confirm = resolve;
    })
  );
  const view = renderGate();
  fireEvent.click(await screen.findByRole('button', { name: 'bridgeWithdrawalDisable' }));
  view.unmount();
  await act(async () => confirm());
  expect(mockOnDisabled).not.toHaveBeenCalled();
  expect(requestLockRescan).toHaveBeenCalledTimes(1);
});

it('lets the user choose another available route without cancelling recovery', async () => {
  jest.mocked(readCompactLockState).mockResolvedValue({ withdrawal: { status: 'Enabled' } });
  const onSelect = jest.fn();
  render(
    <EpochWithdrawalGate {...props} alternative={{ label: 'Use Circle', onSelect }}>
      Bridge
    </EpochWithdrawalGate>
  );
  await screen.findByRole('button', { name: 'bridgeWithdrawalDisable' });
  fireEvent.click(screen.getByRole('button', { name: 'Use Circle' }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(cancelLockWithdrawal).not.toHaveBeenCalled();
});
