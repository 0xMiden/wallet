import React from 'react';

import { render, screen } from '@testing-library/react';

import { TokenAmount } from 'components/ui/TokenAmount';

import { TxStory } from './TxStory';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it('renders a shared amount component inside a transfer description', () => {
  const { container } = render(
    <TxStory
      hops={[
        {
          from: { role: 'you', name: '' },
          to: { role: 'recipient', name: 'recipient' },
          amount: <TokenAmount amount="1.234" symbol="USDC" rounding="up" />,
          via: 'private'
        }
      ]}
    />
  );
  expect(screen.getByText('1.24 USDC')).toBeInTheDocument();
  expect(container.querySelector('.tx-story-amount')).toHaveTextContent('1.24 USDC · private');
  expect(container).not.toHaveTextContent('[object Object]');
});
