import React from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { MainnetAccessOutcome } from 'lib/mainnet-access';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { MainnetCodeEntryFields, useMainnetCodeEntry } from './MainnetCodeEntry';

jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn() } }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
let mockMobile = true;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => mockMobile
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `Visible ${key}` }) }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const mockReport = jest.mocked(reportUserVisibleError);
const mockCheck = jest.fn<Promise<MainnetAccessOutcome>, [string]>();
const mockGranted = jest.fn();
function Entry({ rejected = false }: { rejected?: boolean }) {
  const entry = useMainnetCodeEntry({ check: mockCheck, onGranted: mockGranted, rejected });
  return (
    <form aria-label="Mainnet entry" onSubmit={entry.submit}>
      <MainnetCodeEntryFields entry={entry} testIdPrefix="mainnet" />
      <button type="submit" disabled={!entry.complete || entry.submitting}>
        Check code
      </button>
    </form>
  );
}
const enterCode = () => fireEvent.change(screen.getByTestId('mainnet-code'), { target: { value: 'ABCDEF123456' } });
const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check code' }));
  });
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockMobile = true;
  mockCheck.mockResolvedValue('granted');
});
afterEach(() => {
  jest.useRealTimers();
});

it('accepts ordinary code entry without offering a native clipboard read off mobile', () => {
  mockMobile = false;
  render(<Entry />);
  fireEvent.change(screen.getByTestId('mainnet-code'), { target: { value: 'ABCDEF-123456' } });
  expect(screen.getByTestId('mainnet-code')).toHaveValue('ABCDEF123456');
  expect(screen.getByRole('button', { name: 'Check code' })).toBeEnabled();
  expect(screen.queryByTestId('mainnet-paste')).not.toBeInTheDocument();
  expect(Clipboard.read).not.toHaveBeenCalled();
});

it('keeps mobile native paste and normalizes the returned text', async () => {
  jest.mocked(Clipboard.read).mockResolvedValueOnce({ type: 'text/plain', value: 'ABCDEF-123456' });
  render(<Entry />);
  await act(async () => {
    fireEvent.click(screen.getByTestId('mainnet-paste'));
  });
  expect(screen.getByTestId('mainnet-code')).toHaveValue('ABCDEF123456');
  expect(screen.getByRole('button', { name: 'Check code' })).toBeEnabled();
});

it.each([
  ['rejected', 'mainnetAccessCodeRejected'],
  ['unchecked', 'mainnetAccessCheckFailed'],
  ['clipboard', 'mainnetAccessPasteFailed']
] as const)('reports the real %s producer as %s after 1000 ms', async (failure, id) => {
  render(<Entry />);
  if (failure === 'clipboard') {
    jest.mocked(Clipboard.read).mockRejectedValueOnce(new Error('private clipboard content'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mainnet-paste'));
    });
  } else {
    if (failure === 'unchecked') mockCheck.mockRejectedValueOnce(new Error('private node cause'));
    else mockCheck.mockResolvedValueOnce('rejected');
    enterCode();
    await submit();
  }
  expect(screen.getByTestId('mainnet-error')).toHaveTextContent(`Visible ${id}`);
  act(() => jest.advanceTimersByTime(999));
  expect(mockReport.mock.calls).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
});

it('reports a registration refusal already displayed when the entry opens', () => {
  render(<Entry rejected />);
  expect(screen.getByRole('alert')).toHaveTextContent('Visible mainnetAccessCodeRejected');
  act(() => jest.advanceTimersByTime(999));
  expect(mockReport.mock.calls).toEqual([]);
  act(() => jest.advanceTimersByTime(1));
  expect(mockReport.mock.calls).toEqual([['mainnetAccessCodeRejected', 'inline']]);
});

it('does not report empty entry, hint, pending check or granted success', async () => {
  let finish!: (outcome: MainnetAccessOutcome) => void;
  mockCheck.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  render(<Entry />);
  expect(screen.getByText('Visible mainnetAccessHint')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  enterCode();
  await submit();
  expect(screen.getByTestId('mainnet-code')).toBeDisabled();
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => {
    finish('granted');
  });
  expect(mockGranted).toHaveBeenCalledWith('ABCDEF123456');
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});

it.each(['change', 'unmount'])('drops a refusal cleared at 999 ms by %s', ending => {
  const view = render(<Entry rejected />);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(999));
  if (ending === 'change') enterCode();
  else view.unmount();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});
