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

  it('groups the facts on the shared fill with 16px corners and adds the caller spacing', () => {
    render(<NetworkNoticeRows className="mt-6" />);

    expect(screen.getByRole('list')).toHaveClass('flex', 'flex-col', 'bg-fill', 'rounded-2xl', 'mt-6');
  });

  it('separates the rows with inset hairlines, not a full-bleed rule', () => {
    render(<NetworkNoticeRows />);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.className).toContain('before:bg-hairline');
      expect(row.className).toContain('before:inset-x-4');
      expect(row.className).toContain('first:before:hidden');
    }
  });
});
