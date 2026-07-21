import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import ResetRequired from './ResetRequired';

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// Stub the presentational screen so this suite exercises only the page
// wrapper's wiring (the `onConfirm` -> navigate('/reset-wallet') callback),
// not the screen's own layout/i18n/icon dependencies. The stub surfaces the
// injected `onConfirm` as a clickable button.
jest.mock('screens/onboarding/ResetRequired', () => ({
  __esModule: true,
  default: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" onClick={onConfirm}>
      reset-confirm
    </button>
  )
}));

const mockNavigate = navigate as jest.Mock;

describe('ResetRequired page', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('renders the ResetRequired screen', () => {
    render(<ResetRequired />);

    expect(screen.getByRole('button', { name: 'reset-confirm' })).toBeInTheDocument();
    // The callback only fires on confirm, never on mount.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to the reset-wallet route when the screen confirms', () => {
    render(<ResetRequired />);

    fireEvent.click(screen.getByRole('button', { name: 'reset-confirm' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/reset-wallet');
  });

  it('keeps a stable onConfirm callback across re-renders', () => {
    const { rerender } = render(<ResetRequired />);

    fireEvent.click(screen.getByRole('button', { name: 'reset-confirm' }));
    rerender(<ResetRequired />);
    fireEvent.click(screen.getByRole('button', { name: 'reset-confirm' }));

    expect(mockNavigate).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenNthCalledWith(1, '/reset-wallet');
    expect(mockNavigate).toHaveBeenNthCalledWith(2, '/reset-wallet');
  });
});
