import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import { ArcadePage } from './ArcadePage';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

it('preserves the dashed Coins empty state and pinned Browse games action without a ranking or snapshot flow', () => {
  render(<ArcadePage />);
  expect(screen.getByText('arcadeCoinsUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('0 GC')).toBeNull();
  expect(screen.getByText('arcadeBalancePrivate')).toBeInTheDocument();
  const frame = screen.getByTestId('arcade-coins-page');
  const action = screen.getByRole('button', { name: 'arcadeBrowseGames' });
  expect(frame.querySelector('[data-slot="footer"]')).toContainElement(action);
  expect(frame.querySelector('[data-slot="body"]')).not.toContainElement(action);
  expect(screen.queryByRole('button', { name: 'arcadeGCRankings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadePreview' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeUpdateBalance' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeSubmitBalance' })).toBeNull();
  expect(screen.queryByTestId('arcade-sample-leaderboard')).toBeNull();
  fireEvent.click(action);
  expect(navigate).toHaveBeenCalledWith('/browser?category=arcade');
});
