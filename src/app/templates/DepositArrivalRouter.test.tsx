import React from 'react';

import { render } from '@testing-library/react';

import { DepositArrivalRouter } from './DepositArrivalRouter';

let mockDetectedArrivals: Array<{ token: string; amount: bigint; balance: bigint }> = [];
let mockPathname = '/';
let mockEnabled = true;

jest.mock('lib/deposit-bridge/store', () => ({
  useDepositAddressStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ detectedArrivals: mockDetectedArrivals })
}));

jest.mock('lib/feature-flags', () => ({
  isDepositAddressBridgeEnabled: () => mockEnabled
}));

const navigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (path: string) => navigate(path),
  useLocation: () => ({ pathname: mockPathname })
}));

const ARRIVAL = { token: 'ETH', amount: 8n * 10n ** 14n, balance: 8n * 10n ** 14n };

describe('DepositArrivalRouter', () => {
  beforeEach(() => {
    mockDetectedArrivals = [];
    mockPathname = '/';
    mockEnabled = true;
    navigate.mockClear();
  });

  it('renders nothing', () => {
    const { container } = render(<DepositArrivalRouter />);
    expect(container.firstChild).toBeNull();
  });

  it('opens the waiting screen when money lands unprompted', () => {
    mockDetectedArrivals = [ARRIVAL];
    render(<DepositArrivalRouter />);
    expect(navigate).toHaveBeenCalledWith(
      `/deposit-bridge/approve?token=ETH&amount=${ARRIVAL.amount.toString()}&method=address`
    );
  });

  it('routes an arrival once, however many polls report it', () => {
    mockDetectedArrivals = [ARRIVAL];
    const { rerender } = render(<DepositArrivalRouter />);
    rerender(<DepositArrivalRouter />);
    rerender(<DepositArrivalRouter />);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('routes again for a later, larger deposit', () => {
    mockDetectedArrivals = [ARRIVAL];
    const { rerender } = render(<DepositArrivalRouter />);

    mockDetectedArrivals = [{ token: 'ETH', amount: 2n * 10n ** 18n, balance: 2n * 10n ** 18n }];
    rerender(<DepositArrivalRouter />);

    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('never interrupts a bridge that is already underway', () => {
    mockDetectedArrivals = [ARRIVAL];
    mockPathname = '/generating-transaction/tx-1';
    render(<DepositArrivalRouter />);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not re-route the screens already showing these funds', () => {
    mockDetectedArrivals = [ARRIVAL];
    mockPathname = '/deposit-bridge/review';
    render(<DepositArrivalRouter />);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stays out of the way when the deposit bridge is disabled', () => {
    mockDetectedArrivals = [ARRIVAL];
    mockEnabled = false;
    render(<DepositArrivalRouter />);
    expect(navigate).not.toHaveBeenCalled();
  });
});
