import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { DappNetworkMismatchNotice } from './DappNetworkMismatchNotice';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      `Visible ${key}${values ? ` ${Object.values(values).join(' / ')}` : ''}`
  })
}));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const mockReport = jest.mocked(reportUserVisibleError);
beforeEach(() => {
  jest.useFakeTimers();
  mockReport.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

it.each([undefined, 'testnet'])('does not report hidden claimed network %s', claimedNetwork => {
  const view = render(<DappNetworkMismatchNotice claimedNetwork={claimedNetwork} />);
  expect(view.container).toBeEmptyDOMElement();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});

it.each(['mainnet', 'private-network-name'])('does not report the visible %s mismatch warning', claimedNetwork => {
  const view = render(<DappNetworkMismatchNotice claimedNetwork={claimedNetwork} />);
  expect(screen.getByTestId('dapp-network-mismatch')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('dapp-network-mismatch')).toHaveTextContent(
    `Visible dappNetworkMismatch Visible ${claimedNetwork} / Visible testnet`
  );
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
  view.rerender(<DappNetworkMismatchNotice claimedNetwork="testnet" />);
  expect(view.container).toBeEmptyDOMElement();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockReport.mock.calls).toEqual([]);
});
