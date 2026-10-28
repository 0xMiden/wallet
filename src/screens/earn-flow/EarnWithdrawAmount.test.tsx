import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { navigate } from 'lib/woozie';

import EarnWithdrawAmount from './EarnWithdrawAmount';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { amount?: string; asset?: string }) =>
      key === 'earnWithdrawAvailable' ? `${key} ${args?.amount} ${args?.asset}` : key
  })
}));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), goBack: jest.fn() }));
jest.mock('components/NetworkModeBanner', () => ({ NetworkModeBanner: () => null }));
jest.mock('./components', () => ({
  EarnSubjectSubtitle: () => null,
  EarnAssetMark: () => null,
  EarnAmountUnit: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
  earnSubjectTitle: () => 'Dummy Lending'
}));
let mockAvailable = '10.123456789012345678';
let mockStale = false;
let mockPositionFailure: object = {};
jest.mock('./useEarnPositions', () => ({
  earnItemLoadState: () => ({ loadFailed: false, pending: false }),
  useEarnPositions: () => ({
    positions: [
      {
        id: 'p',
        asset: 'USDC',
        protocol: 'Dummy Lending',
        network: 'Sepolia',
        decimals: 18,
        withdrawable: mockAvailable,
        stale: mockStale
      }
    ],
    ...mockPositionFailure,
    refetch: jest.fn()
  })
}));
jest.mock('lib/i18n/core', () => ({ getCurrentLocale: () => 'en' }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

afterEach(() => {
  mockAvailable = '10.123456789012345678';
  mockStale = false;
  mockPositionFailure = {};
  jest.clearAllMocks();
});
it('offers exact Max and hands only the selected amount to review', () => {
  render(<EarnWithdrawAmount positionId="p" />);
  const amount = screen.getByRole('textbox', { name: 'earnWithdrawAmount' });
  expect(screen.getByRole('button', { name: 'review' })).toBeDisabled();
  fireEvent.change(amount, { target: { value: '1.000000000000000001' } });
  fireEvent.click(screen.getByRole('button', { name: 'review' }));
  expect(navigate).toHaveBeenLastCalledWith('/earn/positions/p/withdraw/review?amount=1.000000000000000001');
  fireEvent.click(screen.getByRole('button', { name: 'max' }));
  fireEvent.click(screen.getByRole('button', { name: 'review' }));
  expect(navigate).toHaveBeenLastCalledWith('/earn/positions/p/withdraw/review?amount=10.123456789012345678');
});
it('keeps balance copy and Max readable while retaining the exact full-balance selection', () => {
  render(<EarnWithdrawAmount positionId="p" />);
  expect(screen.getByText('earnWithdrawAvailable 10.12 USDC')).toBeInTheDocument();
  expect(screen.queryByText(/10\.123456789012345678/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'max' }));
  expect(screen.getByRole('textbox', { name: 'earnWithdrawAmount' })).toHaveValue('10.123456789012345678');
  expect(screen.getByText('earnWithdrawFullBalanceSelected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'review' }));
  expect(navigate).toHaveBeenLastCalledWith('/earn/positions/p/withdraw/review?amount=10.123456789012345678');
});
it('replaces the exact Max selection when the user edits the displayed amount', () => {
  render(<EarnWithdrawAmount positionId="p" />);
  fireEvent.click(screen.getByRole('button', { name: 'max' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'earnWithdrawAmount' }), { target: { value: '2.25' } });
  expect(screen.queryByText('earnWithdrawFullBalanceSelected')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'review' }));
  expect(navigate).toHaveBeenLastCalledWith('/earn/positions/p/withdraw/review?amount=2.25');
});
it.each(['10.123456789012345678', '0.000123456789012345'])(
  'keeps exact Max %s after focusing and blurring without an edit',
  exact => {
    mockAvailable = exact;
    render(<EarnWithdrawAmount positionId="p" />);
    fireEvent.click(screen.getByRole('button', { name: 'max' }));
    const amount = screen.getByRole('textbox', { name: 'earnWithdrawAmount' });
    fireEvent.focus(amount);
    fireEvent.blur(amount);
    expect(screen.getByText('earnWithdrawFullBalanceSelected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    expect(navigate).toHaveBeenLastCalledWith(`/earn/positions/p/withdraw/review?amount=${exact}`);
  }
);
it.each(['0', '-1', '11', '1.1234567890123456789'])('blocks invalid amount %p', value => {
  render(<EarnWithdrawAmount positionId="p" />);
  fireEvent.change(screen.getByRole('textbox', { name: 'earnWithdrawAmount' }), { target: { value } });
  expect(screen.getByRole('button', { name: 'review' })).toBeDisabled();
});
it('revalidates a reduced available balance and stale positions', () => {
  const view = render(<EarnWithdrawAmount positionId="p" />);
  fireEvent.click(screen.getByRole('button', { name: 'max' }));
  mockAvailable = '1';
  view.rerender(<EarnWithdrawAmount positionId="p" />);
  expect(screen.getByText('earnWithdrawAboveAvailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'review' })).toBeDisabled();
  mockStale = true;
  view.rerender(<EarnWithdrawAmount positionId="p" />);
  expect(screen.getByRole('button', { name: 'max' })).toBeDisabled();
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

describe('user-visible amount errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => jest.useRealTimers());
  it.each([
    ['0', 'earnWithdrawPositive'],
    ['11', 'earnWithdrawAboveAvailable'],
    ['1.1234567890123456789', 'earnWithdrawPrecision']
  ])('reports invalid amount %s by its closed key', (value, id) => {
    render(<EarnWithdrawAmount positionId="p" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'earnWithdrawAmount' }), { target: { value } });
    expect(screen.getByText(id)).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'field']]);
  });
  it('does not report the empty or valid amount', () => {
    render(<EarnWithdrawAmount positionId="p" />);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.change(screen.getByRole('textbox', { name: 'earnWithdrawAmount' }), { target: { value: '1' } });
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

it('forwards the selected failure evidence from withdrawal amount to the real Notice', () => {
  jest.useFakeTimers();
  try {
    jest.mocked(reportUserVisibleError).mockClear();
    const evidence = { kind: 'earn_positions_load', earnPositionsLoadStage: 'response_decode', earnPositionsLoadOutcome: 'partial_failure' };
    mockPositionFailure = { error: 'private failure', errorDiagnostics: evidence };
    render(<EarnWithdrawAmount positionId="p" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['earnPositionsLoadError', 'notice', evidence]]);
  } finally { jest.useRealTimers(); }
});
