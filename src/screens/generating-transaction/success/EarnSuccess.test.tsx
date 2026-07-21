import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { ButtonVariant } from 'components/Button';

import { EarnSuccess } from './EarnSuccess';
import type { TransactionSuccessLayoutProps } from './TransactionSuccessLayout';

/**
 * `EarnSuccess` is a thin STUB: it wires the shared `TransactionSuccessLayout`
 * with the earn copy (header "Success!", title "You're Earning!") and a
 * two-button footer where BOTH the primary ("Done") and secondary
 * ("View Details") actions — plus the header close — are currently pointed at
 * the single `onDoneClick` callback (the earn data model / details route don't
 * exist yet). The whole component is one JSX return with no conditional
 * branches, so a single render covers every line; the assertions below verify
 * the exact props it hands to the layout and that all three wiring points fire
 * `onDoneClick`.
 *
 * We mock the shared layout to (a) keep coverage scoped to `EarnSuccess.tsx`
 * and (b) capture the props it receives, since those props ARE the behaviour of
 * this stub. `react-i18next` is mocked to return the caller's `defaultValue`
 * (or the raw key when none is given), mirroring the sibling
 * `TransactionSuccess.test.tsx`.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key
  })
}));

// EarnSuccess only needs the `ButtonVariant` enum from this module. Provide the
// real string values so `variant` assertions are meaningful without pulling in
// the full Button component tree.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// Captures the last props handed to the shared layout. `mock`-prefixed so
// jest's factory-hoisting allows the out-of-scope reference.
let mockLastLayoutProps: TransactionSuccessLayoutProps | undefined;

jest.mock('./TransactionSuccessLayout', () => ({
  __esModule: true,
  TransactionSuccessLayout: (props: TransactionSuccessLayoutProps) => {
    mockLastLayoutProps = props;
    return (
      <div data-testid="layout">
        <span data-testid="header-title">{props.headerTitle}</span>
        <span data-testid="title">{props.title}</span>
        <button data-testid="primary" onClick={props.primaryAction.onClick}>
          {props.primaryAction.label}
        </button>
        {props.secondaryAction && (
          <button data-testid="secondary" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.label}
          </button>
        )}
        <button data-testid="close" aria-label="close" onClick={props.onClose} />
      </div>
    );
  }
}));

describe('EarnSuccess', () => {
  beforeEach(() => {
    mockLastLayoutProps = undefined;
  });

  it('renders the shared success layout with the earn header and title copy', () => {
    render(<EarnSuccess onDoneClick={() => {}} />);

    expect(screen.getByTestId('layout')).toBeInTheDocument();
    // `defaultValue`s flow through the mocked `t`.
    expect(screen.getByTestId('header-title')).toHaveTextContent('Success!');
    expect(screen.getByTestId('title')).toHaveTextContent("You're Earning!");
  });

  it('passes the exact header/title strings to the layout props', () => {
    render(<EarnSuccess onDoneClick={() => {}} />);

    expect(mockLastLayoutProps).toBeDefined();
    expect(mockLastLayoutProps!.headerTitle).toBe('Success!');
    expect(mockLastLayoutProps!.title).toBe("You're Earning!");
  });

  it('wires a Primary "Done" action and a Secondary "View Details" action', () => {
    render(<EarnSuccess onDoneClick={() => {}} />);

    const { primaryAction, secondaryAction } = mockLastLayoutProps!;

    // `t('done')` has no defaultValue → the raw key is used verbatim.
    expect(primaryAction.label).toBe('done');
    expect(primaryAction.variant).toBe(ButtonVariant.Primary);

    expect(secondaryAction).toBeDefined();
    expect(secondaryAction!.label).toBe('View Details');
    expect(secondaryAction!.variant).toBe(ButtonVariant.Secondary);

    // Both buttons render with their labels.
    expect(screen.getByTestId('primary')).toHaveTextContent('done');
    expect(screen.getByTestId('secondary')).toHaveTextContent('View Details');
  });

  it('points the primary action at onDoneClick', () => {
    const onDoneClick = jest.fn();
    render(<EarnSuccess onDoneClick={onDoneClick} />);

    fireEvent.click(screen.getByTestId('primary'));

    expect(onDoneClick).toHaveBeenCalledTimes(1);
  });

  it('points the secondary "View Details" action at onDoneClick (details route not yet wired)', () => {
    const onDoneClick = jest.fn();
    render(<EarnSuccess onDoneClick={onDoneClick} />);

    fireEvent.click(screen.getByTestId('secondary'));

    expect(onDoneClick).toHaveBeenCalledTimes(1);
  });

  it('points the header close (onClose) at onDoneClick', () => {
    const onDoneClick = jest.fn();
    render(<EarnSuccess onDoneClick={onDoneClick} />);

    fireEvent.click(screen.getByTestId('close'));

    expect(onDoneClick).toHaveBeenCalledTimes(1);
  });

  it('routes all three interaction points (primary, secondary, close) to the same handler', () => {
    const onDoneClick = jest.fn();
    render(<EarnSuccess onDoneClick={onDoneClick} />);

    // Same referential handler behind every action.
    expect(mockLastLayoutProps!.primaryAction.onClick).toBe(onDoneClick);
    expect(mockLastLayoutProps!.secondaryAction!.onClick).toBe(onDoneClick);
    expect(mockLastLayoutProps!.onClose).toBe(onDoneClick);

    fireEvent.click(screen.getByTestId('primary'));
    fireEvent.click(screen.getByTestId('secondary'));
    fireEvent.click(screen.getByTestId('close'));

    expect(onDoneClick).toHaveBeenCalledTimes(3);
  });

  it('is exported as a component (function)', () => {
    expect(typeof EarnSuccess).toBe('function');
  });
});
