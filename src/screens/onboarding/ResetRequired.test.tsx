import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import ResetRequired from './ResetRequired';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Icon barrel — expose only the `IconName` members the screen references.
jest.mock('app/icons/v2', () => ({
  IconName: { MidenLogo: 'MidenLogo' },
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />
}));

// `PageHeader` — surface just the title so the header wiring is assertable
// without dragging in `IconButton` / the real icon set.
jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, className }: { title: string; className?: string }) => (
    <div data-testid="nav-header" className={className}>
      {title}
    </div>
  )
}));

// `Button` — render the title and forward the click so `onConfirm` wiring and
// the chosen variant can both be verified.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, variant }: { title: string; onClick?: () => void; variant?: string }) => (
    <button data-testid="reset-button" data-variant={variant} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (onConfirm: () => void = jest.fn()) => render(<ResetRequired onConfirm={onConfirm} />);

describe('ResetRequired', () => {
  it('renders the navigation header with the reset-required title', () => {
    renderComponent();
    expect(screen.getByTestId('nav-header')).toHaveTextContent('resetRequired');
    // PageHeader has no horizontal padding of its own — the page supplies it,
    // or the back button's hit area is clipped by an overflow-hidden ancestor.
    expect(screen.getByTestId('nav-header')).toHaveClass('px-4');
  });

  it('explains under a lone Miden hero, with Reset pinned in the footer', () => {
    renderComponent();

    expect(screen.getByText('resetRequiredDescription')).toHaveClass('text-ink');
    expect(screen.getByText('resetRequiredSecondDescription')).toHaveClass('text-muted');
    expect(screen.getByTestId('icon-MidenLogo')).toBeInTheDocument();
    expect(screen.getByTestId('reset-button').closest('[data-slot="footer"]')).not.toBeNull();
    expect(screen.getAllByText('resetRequired')).toHaveLength(1);
  });

  it('renders the primary reset button', () => {
    renderComponent();

    const button = screen.getByTestId('reset-button');
    expect(button).toHaveTextContent('reset');
    expect(button).not.toHaveAttribute('data-variant');
  });

  it('invokes onConfirm when the reset button is clicked', () => {
    const onConfirm = jest.fn();
    renderComponent(onConfirm);

    fireEvent.click(screen.getByTestId('reset-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onConfirm before any interaction', () => {
    const onConfirm = jest.fn();
    renderComponent(onConfirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
