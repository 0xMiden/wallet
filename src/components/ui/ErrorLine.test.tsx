import React from 'react';

import { render, screen } from '@testing-library/react';

import { ErrorLine } from './ErrorLine';

it('announces the message as a 13px negative line, inset like a section label and selectable', () => {
  render(<ErrorLine data-testid="error">Could not save</ErrorLine>);

  const line = screen.getByRole('alert');
  expect(line).toHaveTextContent('Could not save');
  expect(line).toHaveAttribute('data-testid', 'error');
  expect(line).toHaveClass('px-1', 'text-caption', 'text-negative-ink', 'select-text');
});

it('renders nothing without a message, so a caller can pass its error state straight in', () => {
  const { container } = render(<ErrorLine>{undefined}</ErrorLine>);
  expect(container).toBeEmptyDOMElement();
});

it('takes layout classes from the caller', () => {
  render(<ErrorLine className="mt-3">Nope</ErrorLine>);
  expect(screen.getByRole('alert')).toHaveClass('mt-3');
});

it('can be a standing note rather than an alert', () => {
  render(<ErrorLine role="note">Decimals unknown</ErrorLine>);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Decimals unknown')).toHaveClass('text-negative-ink');
});
