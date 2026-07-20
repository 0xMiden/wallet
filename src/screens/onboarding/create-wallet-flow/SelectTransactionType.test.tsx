import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import { SelectTransactionTypeScreen } from './SelectTransactionType';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back (prefixed) and we can assert rendered labels.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

// `utils/brand-colors` reaches into `lib/miden-chain/constants` for the
// devnet/testnet palette split. Stub the single value this screen consumes.
jest.mock('utils/brand-colors', () => ({
  PRIMARY_HEX: '#E77537'
}));

// `app/icons/v2` is a barrel of SVG re-exports pulling in chain constants.
// Stub the `Icon` component + the one `IconName` member this screen uses.
jest.mock('app/icons/v2', () => ({
  Icon: (props: { name?: string; style?: React.CSSProperties }) => (
    <span data-testid="icon" data-name={props.name} data-color={props.style?.color} />
  ),
  IconName: { CheckboxCircleFill: 'CheckboxCircleFill' }
}));

// `components/Button` drags in framer-motion + haptics + Loader. Replace with a
// plain <button> that surfaces the props this screen sets (title, variant,
// onClick, iconLeft, className) so we can assert selection/continue behaviour.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({
    title,
    onClick,
    variant,
    iconLeft,
    className
  }: {
    title?: string;
    onClick?: () => void;
    variant?: string;
    iconLeft?: React.ReactNode;
    className?: string;
  }) => (
    <button type="button" onClick={onClick} data-variant={variant} className={className}>
      {iconLeft}
      {title}
    </button>
  )
}));

const getRadio = (container: HTMLElement, name: 'delegate' | 'local') =>
  container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

describe('SelectTransactionTypeScreen', () => {
  it('renders the heading and both transaction-type options', () => {
    render(<SelectTransactionTypeScreen />);

    expect(screen.getByText('t:selectTheDefaultTransactionType')).toBeInTheDocument();
    expect(screen.getByText('t:delegateTransactions')).toBeInTheDocument();
    expect(screen.getByText('t:generateTransactionsLocally')).toBeInTheDocument();
  });

  it('shows the "popular" badge only on the delegate (isPopular) option', () => {
    render(<SelectTransactionTypeScreen />);

    // Exactly one badge — the delegate card is flagged isPopular, local is not.
    expect(screen.getAllByText('t:popular')).toHaveLength(1);
  });

  it('renders feature rows with and without subtitles', () => {
    render(<SelectTransactionTypeScreen />);

    // Subtitle-less feature (falsy `feature.subtitle` branch).
    expect(screen.getByText('t:vpnLevelPrivacy')).toBeInTheDocument();
    expect(screen.getByText('t:maximumPrivacy')).toBeInTheDocument();

    // Features whose subtitle is rendered (truthy `feature.subtitle` branch).
    expect(screen.getByText('t:transactionSpeed2Sec')).toBeInTheDocument();
    expect(screen.getByText('t:additionalDownloads0mb')).toBeInTheDocument();
    expect(screen.getByText('t:transactionSpeedMins')).toBeInTheDocument();
    expect(screen.getByText('t:600megabytes')).toBeInTheDocument();

    // Shared feature title appears in both cards.
    expect(screen.getAllByText('t:transactionSpeed')).toHaveLength(2);
    expect(screen.getAllByText('t:yourKeysStayPrivate')).toHaveLength(2);
  });

  it('defaults selection to the delegate option', () => {
    const { container } = render(<SelectTransactionTypeScreen />);

    expect(getRadio(container, 'delegate').checked).toBe(true);
    expect(getRadio(container, 'local').checked).toBe(false);

    // Selected card shows the "selected" ghost button with the checkmark icon.
    const selectedButton = screen.getByRole('button', { name: /t:selected/ });
    expect(selectedButton).toHaveAttribute('data-variant', 'ghost');
    expect(within(selectedButton).getByTestId('icon')).toHaveAttribute('data-name', 'CheckboxCircleFill');
    expect(within(selectedButton).getByTestId('icon')).toHaveAttribute('data-color', '#E77537');

    // Unselected card shows the secondary "select" button with no icon.
    const unselectedButton = screen.getByRole('button', { name: 't:select' });
    expect(unselectedButton).toHaveAttribute('data-variant', 'secondary');
    expect(within(unselectedButton).queryByTestId('icon')).toBeNull();
  });

  it('switches selection when the local card is clicked', () => {
    const { container } = render(<SelectTransactionTypeScreen />);

    // Clicking any child of the local card bubbles to the card-level onClick.
    fireEvent.click(screen.getByText('t:generateTransactionsLocally'));

    expect(getRadio(container, 'local').checked).toBe(true);
    expect(getRadio(container, 'delegate').checked).toBe(false);

    // Click the delegate card to flip the selection back.
    fireEvent.click(screen.getByText('t:delegateTransactions'));

    expect(getRadio(container, 'delegate').checked).toBe(true);
    expect(getRadio(container, 'local').checked).toBe(false);
  });

  it('calls onSubmit with the currently selected type on continue', () => {
    const onSubmit = jest.fn();
    render(<SelectTransactionTypeScreen onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 't:continue' }));
    expect(onSubmit).toHaveBeenCalledWith('delegate');

    // Change the selection, then continue again with the new value.
    fireEvent.click(screen.getByText('t:generateTransactionsLocally'));
    fireEvent.click(screen.getByRole('button', { name: 't:continue' }));
    expect(onSubmit).toHaveBeenLastCalledWith('local');

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not throw on continue when onSubmit is omitted', () => {
    render(<SelectTransactionTypeScreen />);

    expect(() => fireEvent.click(screen.getByRole('button', { name: 't:continue' }))).not.toThrow();
  });

  it('forwards className and extra props onto the root element', () => {
    const { container } = render(<SelectTransactionTypeScreen className="my-custom-class" data-testid="root-node" />);

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('my-custom-class');
    expect(root).toHaveClass('bg-app-bg');
    expect(root).toHaveAttribute('data-testid', 'root-node');
  });
});
