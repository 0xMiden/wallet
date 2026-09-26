import React from 'react';

import { render, screen } from '@testing-library/react';

import { NetworkNoticeRows } from './NetworkNoticeRows';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

describe('NetworkNoticeRows (#875)', () => {
  it('lists the three test-network facts, each with its own title and body, in order', () => {
    render(<NetworkNoticeRows />);

    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'networkNoticeNoValueTitlenetworkNoticeNoValueBody',
      'networkNoticeNoRealFundsTitlenetworkNoticeNoRealFundsBody',
      'networkNoticeResetTitlenetworkNoticeResetBody'
    ]);
  });

  it('sets the facts straight on the page, no group fill, and adds the caller spacing', () => {
    render(<NetworkNoticeRows className="mt-6" />);

    const list = screen.getByRole('list');
    expect(list).toHaveClass('flex', 'flex-col', 'mt-6');
    expect(list).not.toHaveClass('bg-fill');
  });

  it('draws each fact as the shared FactRow, whose own test pins the hairline after the icon', () => {
    render(<NetworkNoticeRows />);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveAttribute('data-slot', 'fact-row');
  });

  it('leads each fact with a decorative Settings-style icon in its card colour', () => {
    render(<NetworkNoticeRows />);

    const tones = { 'no-value': 'text-card-green', 'no-real-funds': 'text-card-purple', reset: 'text-card-blue' };
    for (const [id, tone] of Object.entries(tones)) {
      const icon = screen.getByTestId(`network-notice-row-${id}`).querySelector('[data-slot="icon"]');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).toHaveClass('h-8', 'w-8', 'rounded-full', 'bg-fill', tone);
      expect(icon?.querySelector('svg')).not.toBeNull();
    }
  });
});
