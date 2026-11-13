import React from 'react';

import { render, screen } from '@testing-library/react';

import { Input } from './Input';

it('associates its visible label with the supplied input ID', () => {
  render(<Input id="acceptance-password" label="Password" type="password" />);
  expect(screen.getByLabelText('Password')).toHaveAttribute('id', 'acceptance-password');
});

describe('Input theme colors', () => {
  it('uses theme-aware colors for its label, value, and icon slot', () => {
    const { container } = render(
      <Input label="Password" icon={<span data-testid="visibility-icon" />} defaultValue="secret" />
    );

    expect(screen.getByText('Password')).toHaveClass('text-ink');
    expect(container.querySelector('input')).toHaveClass('text-ink');
    expect(screen.getByTestId('visibility-icon').parentElement).toHaveClass('text-ink');
  });
});
