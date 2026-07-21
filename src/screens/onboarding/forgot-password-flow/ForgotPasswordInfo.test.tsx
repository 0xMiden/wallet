import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import ForgotPasswordInfo from './ForgotPasswordInfo';

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
  IconName: { Lock: 'Lock' }
}));

// `NavigationHeader` — surface the title, mode and the close handler so the
// header wiring is assertable without dragging in `CircleButton` / the real
// icon set.
jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, mode, onClose }: { title: string; mode?: string; onClose?: () => void }) => (
    <div data-testid="nav-header" data-mode={mode}>
      <span data-testid="nav-header-title">{title}</span>
      <button data-testid="nav-header-close" onClick={onClose}>
        close
      </button>
    </div>
  )
}));

// `Message` — echo every prop the screen threads through as data attributes /
// text so each one can be asserted individually.
jest.mock('components/Message', () => ({
  Message: ({
    title,
    description,
    secondDescription,
    icon,
    descriptionClasses,
    className
  }: {
    title: string;
    description: string;
    secondDescription?: string;
    icon: string;
    descriptionClasses?: string;
    className?: string;
  }) => (
    <div
      data-testid="message"
      data-icon={icon}
      data-description-classes={descriptionClasses}
      data-classname={className}
    >
      <span data-testid="message-title">{title}</span>
      <span data-testid="message-description">{description}</span>
      <span data-testid="message-second-description">{secondDescription}</span>
    </div>
  )
}));

// `Button` — render the title and forward the click so `onSignOut` wiring and
// the chosen variant can both be verified.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, variant }: { title: string; onClick?: () => void; variant?: string }) => (
    <button data-testid="sign-out-button" data-variant={variant} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (onClose: () => void = jest.fn(), onSignOut: () => void = jest.fn()) =>
  render(<ForgotPasswordInfo onClose={onClose} onSignOut={onSignOut} />);

describe('ForgotPasswordInfo', () => {
  it('renders the navigation header in close mode with the forgot-password title', () => {
    renderComponent();

    const header = screen.getByTestId('nav-header');
    expect(screen.getByTestId('nav-header-title')).toHaveTextContent('forgotPassword');
    expect(header).toHaveAttribute('data-mode', 'close');
  });

  it('renders the Message with the forgot-password copy, lock icon and description sizing', () => {
    renderComponent();

    const message = screen.getByTestId('message');
    expect(screen.getByTestId('message-title')).toHaveTextContent('forgotPassword');
    expect(screen.getByTestId('message-description')).toHaveTextContent('forgotPasswordDescription');
    expect(screen.getByTestId('message-second-description')).toHaveTextContent('forgotPasswordSecondDescription');
    expect(message).toHaveAttribute('data-icon', 'Lock');
    expect(message).toHaveAttribute('data-description-classes', 'text-sm');
    expect(message).toHaveAttribute('data-classname', 'flex-1');
  });

  it('renders the primary sign-out button', () => {
    renderComponent();

    const button = screen.getByTestId('sign-out-button');
    expect(button).toHaveTextContent('signOut');
    expect(button).toHaveAttribute('data-variant', 'Primary');
  });

  it('invokes onClose when the header close control is clicked', () => {
    const onClose = jest.fn();
    renderComponent(onClose);

    fireEvent.click(screen.getByTestId('nav-header-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onSignOut when the sign-out button is clicked', () => {
    const onSignOut = jest.fn();
    renderComponent(jest.fn(), onSignOut);

    fireEvent.click(screen.getByTestId('sign-out-button'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the two handlers independent — closing does not sign out and vice versa', () => {
    const onClose = jest.fn();
    const onSignOut = jest.fn();
    renderComponent(onClose, onSignOut);

    fireEvent.click(screen.getByTestId('nav-header-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sign-out-button'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not invoke either handler before any interaction', () => {
    const onClose = jest.fn();
    const onSignOut = jest.fn();
    renderComponent(onClose, onSignOut);

    expect(onClose).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
  });
});
