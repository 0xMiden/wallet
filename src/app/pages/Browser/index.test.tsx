import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { ExploreFilter } from 'lib/dapp-browser/explore-catalog';
import { HistoryAction, navigate } from 'lib/woozie';

import Browser from './index';

const mockLocation = { pathname: '/browser', search: '?category=arcade', trigger: 'pushstate', historyPosition: 3 };
jest.mock('lib/woozie', () => ({
  useLocation: () => mockLocation,
  navigate: jest.fn(),
  HistoryAction: { Replace: 'replacestate', Push: 'pushstate' }
}));
jest.mock('./BrowserScreen', () => ({
  BrowserScreen: ({
    requestedFilter,
    entryIntent,
    onChooseFilter
  }: {
    requestedFilter?: ExploreFilter;
    entryIntent?: number;
    onChooseFilter: (filter: ExploreFilter) => void;
  }) => (
    <button
      data-testid="browser"
      data-filter={requestedFilter}
      data-entry={entryIntent}
      onClick={() => onChooseFilter('finance')}
    />
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockLocation.pathname = '/browser';
  mockLocation.search = '?category=arcade';
  mockLocation.trigger = 'pushstate';
});

it('selects the Home banner category on the first frame and replaces category changes', () => {
  render(<Browser />);
  expect(screen.getByTestId('browser')).toHaveAttribute('data-filter', 'arcade');
  expect(screen.getByTestId('browser')).toHaveAttribute('data-entry', '3');
  fireEvent.click(screen.getByTestId('browser'));
  expect(navigate).toHaveBeenCalledWith({ pathname: '/browser', search: '?category=finance' }, HistoryAction.Replace);
});

it.each(['popstate', 'replacestate'])('does not clear retained search on %s navigation', trigger => {
  mockLocation.trigger = trigger;
  render(<Browser />);
  expect(screen.getByTestId('browser')).not.toHaveAttribute('data-entry');
});

it('ignores unknown categories and query parameters on a different active page', () => {
  mockLocation.search = '?category=not-a-category';
  const { rerender } = render(<Browser />);
  expect(screen.getByTestId('browser')).not.toHaveAttribute('data-filter');
  mockLocation.search = '?category=arcade';
  mockLocation.pathname = '/history';
  rerender(<Browser />);
  expect(screen.getByTestId('browser')).not.toHaveAttribute('data-filter');
});
