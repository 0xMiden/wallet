import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { USD_QUOTE_MAX_AGE_MS } from 'lib/prices/amount';

import { UsdValue } from './TokenUsdValue';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, args: { value: string }) => args.value })
}));

it('expires a mounted estimate even if prices stop updating', () => {
  jest.useFakeTimers();
  jest.setSystemTime(1800000000000);
  const quote = { price: 2, change24h: 0, percentageChange24h: 0, observedAt: Date.now() };
  const view = render(<UsdValue amount="3" quote={quote} />);
  expect(screen.getByText('$6.00')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS));
  expect(screen.getByText('$6.00')).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(1));
  expect(screen.queryByText('$6.00')).not.toBeInTheDocument();
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
