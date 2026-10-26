import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { RecoverySeedPrompt } from './RecoverySeedPrompt';

const mockProvideSeed = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) => selector({ provideRecoverySeed: mockProvideSeed })
}));
jest.mock('lib/miden/activity', () => ({ requestSWTransactionProcessing: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/mobile/screenshot-guard', () => ({ useScreenshotGuard: () => true }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `Visible ${key}` })
}));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const mockReport = jest.mocked(reportUserVisibleError);
const transaction: ITransaction = {
  id: 'recovery-transaction',
  accountId: 'recovery-account',
  type: 'replace-hot-key',
  status: ITransactionStatus.Queued,
  initiatedAt: 1,
  displayIcon: 'DEFAULT'
};
const privateFailure = 'recovery rejected for 0x1234abcd amount 42 at https://private.invalid';
const enterSeed = () => {
  const phrase = [...Array(11).fill('abandon'), 'about'].join(' ');
  fireEvent.paste(screen.getAllByRole('textbox')[0]!, { clipboardData: { getData: () => phrase } });
};
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('import-seed-submit'));
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockProvideSeed.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.useRealTimers();
});

it.each([
  [new Error(privateFailure), privateFailure, 'raw_recovery_seed_submit_failed'],
  ['untyped rejection', 'Visible invalidRecoverySeed', 'invalidRecoverySeed']
])('reports the recovery producer identity after a displayed %p rejection dwells', async (failure, copy, id) => {
  mockProvideSeed.mockRejectedValueOnce(failure);
  const view = render(<RecoverySeedPrompt transaction={transaction} onClose={jest.fn()} />);
  enterSeed();
  await submit();
  expect(screen.getByRole('alert')).toHaveTextContent(copy);
  act(() => jest.advanceTimersByTime(999));
  expect(mockReport.mock.calls).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
  view.rerender(<RecoverySeedPrompt transaction={{ ...transaction, amount: 99n }} onClose={jest.fn()} />);
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
});

it('does not report idle entry, recovery explanation, pending submission or success', async () => {
  let finish!: () => void;
  mockProvideSeed.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  render(<RecoverySeedPrompt transaction={transaction} onClose={jest.fn()} />);
  expect(screen.getByText('Visible recoverySeedTemporaryDescription')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  enterSeed();
  await submit();
  expect(screen.getByTestId('import-seed-submit')).toBeDisabled();
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => {
    finish();
  });
  expect(screen.getAllByRole('textbox')[0]).toHaveValue('');
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});

it.each(['retry', 'close'])('drops a recovery error cleared before dwell by %s', async ending => {
  mockProvideSeed.mockRejectedValueOnce(new Error(privateFailure)).mockImplementationOnce(() => new Promise(() => {}));
  const onClose = jest.fn();
  const view = render(<RecoverySeedPrompt transaction={transaction} onClose={onClose} />);
  enterSeed();
  await submit();
  expect(screen.getByRole('alert')).toHaveTextContent(privateFailure);
  act(() => jest.advanceTimersByTime(999));
  if (ending === 'retry') await submit();
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Visible close' }));
    view.unmount();
  }
  expect(onClose).toHaveBeenCalledTimes(ending === 'close' ? 1 : 0);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});
