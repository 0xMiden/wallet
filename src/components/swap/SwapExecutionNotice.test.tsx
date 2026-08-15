import React from 'react';

import { render, screen } from '@testing-library/react';

import { SwapExecutionNotice } from './SwapExecutionNotice';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  IconName: { Information: 'information' },
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />
}));

describe('SwapExecutionNotice', () => {
  it('always explains that the swap executes on the protocol DEX', () => {
    render(<SwapExecutionNotice outputSymbol="IMIDEN" />);

    expect(screen.getByText('swapExecutionVenueExplanation')).toBeInTheDocument();
    expect(screen.queryByText('swapIethExplanation')).not.toBeInTheDocument();
  });

  it('also explains iETH when it is the output asset', () => {
    render(<SwapExecutionNotice outputSymbol="iETH" className="mt-3" />);

    expect(screen.getByText('swapIethExplanation')).toBeInTheDocument();
    expect(screen.getByTestId('swap-execution-notice')).toHaveClass('mt-3');
    expect(screen.getByTestId('icon-information')).toBeInTheDocument();
  });
});
