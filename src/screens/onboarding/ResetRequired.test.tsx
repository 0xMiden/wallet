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
  IconName: { MidenLogo: 'MidenLogo' }
}));

// `NavigationHeader` — surface just the title so the header wiring is
// assertable without dragging in `CircleButton` / the real icon set.
jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title }: { title: string }) => <div data-testid="nav-header">{title}</div>
}));

// `Message` — echo every prop the screen threads through as data attributes /
// text so each one can be asserted individually.
jest.mock('components/Message', () => ({
  Message: ({
    title,
    description,
    secondDescription,
    icon,
    iconClassName,
    className
  }: {
    title: string;
    description: string;
    secondDescription?: string;
    icon: string;
    iconClassName?: string;
    className?: string;
  }) => (
    <div
      data-testid="message"
      data-icon={icon}
      data-icon-classname={iconClassName}
      data-classname={className}
    >
      <span data-testid="message-title">{title}</span>
      <span data-testid="message-description">{description}</span>
      <span data-testid="message-second-description">{secondDescription}</span>
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
  });

  it('renders the Message with the reset-required copy, icon and icon sizing', () => {
    renderComponent();

    const message = screen.getByTestId('message');
    expect(screen.getByTestId('message-title')).toHaveTextContent('resetRequired');
    expect(screen.getByTestId('message-description')).toHaveTextContent('resetRequiredDescription');
    expect(screen.getByTestId('message-second-description')).toHaveTextContent('resetRequiredSecondDescription');
    expect(message).toHaveAttribute('data-icon', 'MidenLogo');
    expect(message).toHaveAttribute('data-icon-classname', 'w-[218px] h-[218px]');
    expect(message).toHaveAttribute('data-classname', 'flex-1');
  });

  it('renders the primary reset button', () => {
    renderComponent();

    const button = screen.getByTestId('reset-button');
    expect(button).toHaveTextContent('reset');
    expect(button).toHaveAttribute('data-variant', 'Primary');
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
