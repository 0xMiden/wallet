import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DepositField } from './parts';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

describe('DepositField', () => {
  it('names the field by its label, describes it by its hint and reports each change', () => {
    const onChange = jest.fn();
    render(
      <DepositField
        label="Refund address"
        value=""
        onChange={onChange}
        placeholder="Your Solana address"
        hint="If the transfer fails"
        trailing={<button type="button">Paste</button>}
        data-testid="field"
      />
    );
    const input = screen.getByLabelText('Refund address');
    expect(input).toBe(screen.getByTestId('field'));
    expect(input).toHaveAttribute('placeholder', 'Your Solana address');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).toHaveAccessibleDescription('If the transfer fails');
    expect(screen.getByTestId('field-hint')).toHaveTextContent('If the transfer fails');
    expect(screen.getByRole('button', { name: 'Paste' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  it('shows the error in the place of the hint and marks the field invalid', () => {
    render(
      <DepositField
        label="Refund address"
        value="x"
        onChange={jest.fn()}
        hint="hint"
        error="Not valid"
        data-testid="field"
      />
    );
    expect(screen.getByTestId('field')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('field')).toHaveAccessibleDescription('Not valid');
    expect(screen.getByTestId('field-error')).toHaveTextContent('Not valid');
    expect(screen.queryByTestId('field-hint')).not.toBeInTheDocument();
  });

  it('has no line under it with no hint and no error', () => {
    render(<DepositField label="Refund address" value="" onChange={jest.fn()} />);
    expect(screen.getByLabelText('Refund address')).not.toHaveAttribute('aria-describedby');
  });
});
