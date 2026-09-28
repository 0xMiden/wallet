import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ProtectorProbeErrorNotice } from './ProtectorProbeErrorNotice';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

afterEach(cleanup);

it('shows the failure notice with an enabled Retry that calls onRetry', () => {
  const onRetry = jest.fn();
  render(<ProtectorProbeErrorNotice onRetry={onRetry} retrying={false} />);

  expect(screen.getByTestId('protector-probe-error')).toHaveTextContent('couldNotCheckUnlockMethod');
  const retry = screen.getByTestId('protector-probe-retry');
  expect(retry).toBeEnabled();
  expect(retry).not.toHaveAttribute('aria-busy');

  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

// #1241: every screen test resolves its retry probe in one pass, so nothing exercises the button
// while its own attempt is in flight. A retry has to keep the notice up and the button disabled and
// loading until that attempt settles, or a second click could fire a second probe underneath it.
it('keeps the notice up and disables Retry with aria-busy while a retry is in flight', () => {
  render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying />);

  expect(screen.getByTestId('protector-probe-error')).toBeInTheDocument();
  const retry = screen.getByTestId('protector-probe-retry');
  expect(retry).toBeDisabled();
  expect(retry).toHaveAttribute('aria-busy', 'true');
});

// #1241: Button's default width caps at `max-w-92.5`, which left Retry left-aligned and narrower
// than the full-width Notice above it wherever the notice renders, including RotateGuardianReview's
// stacked footer next to a `max-w-none` Continue.
it('spans the full notice width, uncapped, everywhere it renders', () => {
  render(<ProtectorProbeErrorNotice onRetry={jest.fn()} retrying={false} />);

  expect(screen.getByTestId('protector-probe-retry')).toHaveClass('max-w-none');
});
