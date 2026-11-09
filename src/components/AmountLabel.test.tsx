import React from 'react';

import { render, screen } from '@testing-library/react';

import { AmountLabel } from './AmountLabel';

it('keeps the old amount API on the shared display policy', () => {
  render(<AmountLabel amount="1.5747999999999986" currency="$" className="text-ink" data-testid="amount" />);
  expect(screen.getByTestId('amount')).toHaveTextContent('$1.57');
  expect(screen.getByTestId('amount')).toHaveClass('text-ink');
  expect(screen.getByTitle('$1.5747999999999986')).toBeInTheDocument();
});
