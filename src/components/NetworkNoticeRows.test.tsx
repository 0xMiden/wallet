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

  it('keeps its own list layout and adds the caller spacing', () => {
    render(<NetworkNoticeRows className="mt-6" />);

    expect(screen.getByRole('list')).toHaveClass('flex', 'flex-col', 'divide-y', 'mt-6');
  });
});
