import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import FundWalletDrawer, { FundWalletDrawer as NamedFundWalletDrawer, FundWalletDrawerProps } from './FundWalletDrawer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Identity translator — labels echo the raw i18n key so assertions can match
// on keys without the i18n runtime.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Icon barrel stub — echo the icon `name` so the per-state glyph can be told
// apart, and keep the whole `app/icons/v2` tree out of the module graph.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="icon" data-name={name} className={className} />
  ),
  IconName: { Loader: 'loader', Checkmark: 'checkmark', Close: 'close' }
}));

// Button — render the title and forward the click so footer wiring is testable.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button data-testid={`btn-${title}`} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// Drawer — passthrough stub that keeps children in the DOM and exposes the
// `open` prop plus a handle to fire `onOpenChange`.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-onOpenChange-false" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-footer">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeProps = (overrides: Partial<FundWalletDrawerProps> = {}): FundWalletDrawerProps => ({
  open: true,
  onOpenChange: jest.fn(),
  state: 'loading',
  onRetry: jest.fn(),
  onDone: jest.fn(),
  ...overrides
});

const renderDrawer = (props: FundWalletDrawerProps = makeProps()) => render(<FundWalletDrawer {...props} />);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FundWalletDrawer', () => {
  it('forwards the open prop to the drawer scaffold', () => {
    renderDrawer(makeProps({ open: false }));
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('renders the loading state with a live status region and no actionable footer button', () => {
    renderDrawer(makeProps({ state: 'loading' }));

    expect(screen.getByTestId('drawer-title')).toHaveTextContent('fundWalletLoadingTitle');
    expect(screen.getByText('fundWalletLoadingBody')).toBeInTheDocument();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'loader');

    // No Done / Retry / Close buttons while loading.
    expect(screen.queryByTestId('btn-done')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-retry')).not.toBeInTheDocument();
  });

  it('renders the success state and calls onDone from the Done button', () => {
    const onDone = jest.fn();
    renderDrawer(makeProps({ state: 'success', onDone }));

    expect(screen.getByTestId('drawer-title')).toHaveTextContent('fundWalletSuccessTitle');
    expect(screen.getByText('fundWalletSuccessBody')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'checkmark');
    // Success is announced too (polite live region) — not left silent to AT.
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(screen.getByTestId('btn-done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('renders the error state with the real message, retry, and close wiring', () => {
    const onRetry = jest.fn();
    const onDone = jest.fn();
    renderDrawer(makeProps({ state: 'error', errorMessage: 'rate limited', onRetry, onDone }));

    expect(screen.getByTestId('drawer-title')).toHaveTextContent('fundWalletErrorTitle');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('rate limited');
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'close');

    fireEvent.click(screen.getByTestId('btn-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('btn-close'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic error body when no error message is provided', () => {
    renderDrawer(makeProps({ state: 'error', errorMessage: undefined }));
    expect(screen.getByText('fundWalletErrorBody')).toBeInTheDocument();
  });

  it('propagates the drawer scaffold onOpenChange requests', () => {
    const onOpenChange = jest.fn();
    renderDrawer(makeProps({ onOpenChange }));

    fireEvent.click(screen.getByTestId('drawer-onOpenChange-false'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedFundWalletDrawer).toBe(FundWalletDrawer);
  });
});
