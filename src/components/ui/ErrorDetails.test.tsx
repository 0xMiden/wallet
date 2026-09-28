import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ErrorDetails } from './ErrorDetails';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

describe('ErrorDetails', () => {
  it('puts a caller-supplied test id on its wrapper', () => {
    render(<ErrorDetails details="Error: request timeout" data-testid="failure-details" />);

    expect(screen.getByTestId('failure-details')).toContainElement(
      screen.getByRole('button', { name: 'showFullError' })
    );
  });

  it('hides the details until the toggle is pressed, and hides them again', () => {
    render(<ErrorDetails details="Error: request timeout" />);

    const toggle = screen.getByRole('button', { name: 'showFullError' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Error: request timeout')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const shown = screen.getByText('Error: request timeout');
    expect(screen.getByRole('button', { name: 'hideFullError' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'hideFullError' })).toHaveAttribute('aria-controls', shown.id);

    fireEvent.click(screen.getByRole('button', { name: 'hideFullError' }));
    expect(screen.queryByText('Error: request timeout')).not.toBeInTheDocument();
  });

  it('wraps a long unbreakable token instead of widening its box', () => {
    const token = `0x${'ab'.repeat(100)}`;
    render(<ErrorDetails details={token} />);
    fireEvent.click(screen.getByRole('button', { name: 'showFullError' }));

    // `anywhere`, not `break-word`: only it lowers min-content width, which a fit-content box sizes to.
    expect(screen.getByText(token)).toHaveClass('wrap-anywhere', 'select-text');
  });

  it.each([[undefined], ['']])('renders nothing for details %p', details => {
    const { container } = render(<ErrorDetails details={details} />);
    expect(container).toBeEmptyDOMElement();
  });
});
