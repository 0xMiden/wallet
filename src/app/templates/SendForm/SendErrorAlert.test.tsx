/**
 * SendErrorAlert — maps a thrown Send/estimation error to the right Alert
 * `type`, `title`, and `description`. The component is two `switch (true)`
 * blocks driven by `instanceof` against the ArtificialError hierarchy
 * (ZeroBalanceError / ZeroTEZBalanceError extend NotEnoughFundsError extends
 * ArtificialError extends Error), plus a `type === 'submit'` ternary in the
 * default title/description and in the Alert `type` prop. These tests drive one
 * error per branch (order-sensitive: ZeroTEZ is checked before NotEnoughFunds
 * in the title, ZeroBalance before ZeroTEZ before NotEnoughFunds in the
 * description) across both `type` values to reach ~100%.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';

import { NotEnoughFundsError, ZeroBalanceError, ZeroTEZBalanceError } from 'app/defaults';

import SendErrorAlert from './SendErrorAlert';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key, and when interpolation options are supplied append
// them as JSON so the `{ currency: 'ꜩ' }` / `{ gasTokenSymbol: 'MDN' }` params
// threaded into `t(...)` are directly assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key)
  })
}));

// `Alert` is exercised by its own atom test; here we only care about the props
// SendErrorAlert threads into it. Capture `type` (the error/warn ternary),
// `title`, `description`, `autoFocus`, and `className` on data attributes /
// child nodes so every branch's output is assertable without the atom's
// focus/close/svg plumbing.
jest.mock('app/atoms/Alert', () => ({
  __esModule: true,
  default: ({
    type,
    title,
    description,
    autoFocus,
    className
  }: {
    type?: string;
    title?: React.ReactNode;
    description?: React.ReactNode;
    autoFocus?: boolean;
    className?: string;
  }) => (
    <div data-testid="alert" data-type={type} data-autofocus={String(autoFocus)} data-classname={className}>
      <div data-testid="alert-title">{title}</div>
      <div data-testid="alert-description">{description}</div>
    </div>
  )
}));

const title = () => screen.getByTestId('alert-title').textContent ?? '';
const description = () => screen.getByTestId('alert-description').textContent ?? '';

describe('SendErrorAlert', () => {
  it('ZeroTEZBalanceError → currency-funds title + main-asset-zero description (submit ⇒ error)', () => {
    render(<SendErrorAlert type="submit" error={new ZeroTEZBalanceError()} />);

    // submit maps the Alert to the `error` variant.
    expect(screen.getByTestId('alert')).toHaveAttribute('data-type', 'error');
    // Static props are always forwarded.
    expect(screen.getByTestId('alert')).toHaveAttribute('data-autofocus', 'true');
    expect(screen.getByTestId('alert')).toHaveAttribute('data-classname', 'mt-6 mb-4');

    // Title switch: ZeroTEZ is the FIRST case, so it wins over its
    // NotEnoughFunds supertype and interpolates the tez currency glyph.
    expect(title()).toContain('notEnoughCurrencyFunds');
    expect(title()).toContain('ꜩ');
    // Description switch: not a ZeroBalanceError, so it falls to the ZeroTEZ case.
    expect(description()).toBe('mainAssetBalanceIsZero');
  });

  it('ZeroBalanceError → not-enough-funds title + balance-zero description', () => {
    render(<SendErrorAlert type="submit" error={new ZeroBalanceError()} />);

    // Title: ZeroBalanceError is NOT a ZeroTEZBalanceError (sibling), so the
    // first case misses and it lands on the NotEnoughFunds case.
    expect(title().trim()).toBe('notEnoughFunds');
    // Description: ZeroBalance is the FIRST description case.
    expect(description()).toBe('yourBalanceIsZero');
  });

  it('NotEnoughFundsError → not-enough-funds title + minimal-fee description with MDN symbol', () => {
    render(<SendErrorAlert type="submit" error={new NotEnoughFundsError()} />);

    expect(title().trim()).toBe('notEnoughFunds');
    // Not ZeroBalance, not ZeroTEZ → the NotEnoughFunds description case, which
    // interpolates the hard-coded gas-token symbol.
    expect(description()).toContain('minimalFeeGreaterThanBalanceVerbose');
    expect(description()).toContain('MDN');
  });

  it('generic Error (submit) → failed title + verbose "unable to send" default description', () => {
    render(<SendErrorAlert type="submit" error={new Error('boom')} />);

    expect(screen.getByTestId('alert')).toHaveAttribute('data-type', 'error');
    // Both switches fall through to their defaults.
    expect(title()).toBe('failed');

    const desc = description();
    // submit ⇒ the "unable to send" action copy, never the estimation copy.
    expect(desc).toContain('unableToSendTransactionAction');
    expect(desc).not.toContain('unableToEstimateTransactionAction');
    // The default description also renders the reason list.
    expect(desc).toContain('thisMayHappenBecause');
    expect(desc).toContain('minimalFeeGreaterThanBalanceVerbose');
    expect(desc).toContain('MDN');
    expect(desc).toContain('networkOrOtherIssue');
  });

  it('generic Error (estimation) → warn variant + "unable to estimate" default description', () => {
    render(<SendErrorAlert type="estimation" error={new Error('nope')} />);

    // estimation maps the Alert to the `warn` variant.
    expect(screen.getByTestId('alert')).toHaveAttribute('data-type', 'warn');
    expect(title()).toBe('failed');

    const desc = description();
    // estimation ⇒ the else-branch of the default-description ternary.
    expect(desc).toContain('unableToEstimateTransactionAction');
    expect(desc).not.toContain('unableToSendTransactionAction');
    expect(desc).toContain('thisMayHappenBecause');
    expect(desc).toContain('networkOrOtherIssue');
  });

  it('estimation with a fund error still uses the warn variant (type is independent of the error branch)', () => {
    // Guards the Alert `type` ternary against the error-driven title/description
    // switches: a NotEnoughFundsError under estimation stays `warn`.
    render(<SendErrorAlert type="estimation" error={new NotEnoughFundsError()} />);

    expect(screen.getByTestId('alert')).toHaveAttribute('data-type', 'warn');
    expect(title().trim()).toBe('notEnoughFunds');
    expect(description()).toContain('minimalFeeGreaterThanBalanceVerbose');
  });
});
