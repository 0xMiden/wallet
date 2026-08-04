import React from 'react';

import { render, screen } from '@testing-library/react';

import { Input } from './Input';

describe('Input theme colors', () => {
  it('uses theme-aware colors for its label, value, and icon slot', () => {
    const { container } = render(
      <Input label="Password" icon={<span data-testid="visibility-icon" />} defaultValue="secret" />
    );

    expect(screen.getByText('Password')).toHaveClass('text-heading-gray');
    expect(container.querySelector('input')).toHaveClass('text-black');
    expect(screen.getByTestId('visibility-icon').parentElement).toHaveClass('text-heading-gray');
  });
});
