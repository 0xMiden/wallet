import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { WelcomeScreen } from './Welcome';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `isMobile` gates the top-padding class on the button column. A mutable holder
// lets individual tests flip the platform to exercise both the mobile (`pt-8`)
// and non-mobile (`pt-6`) branches.
const mockPlatform = { isMobile: false };
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile
}));

// `hapticLight`/`hapticMedium` are native Capacitor wrappers; replace them with
// spies so the recover-link and logo-unlock tap wiring can be asserted without
// touching the plugin.
const hapticLight = jest.fn();
const hapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => hapticLight(),
  hapticMedium: () => hapticMedium()
}));

// `navigate` from the woozie router; the logo easter-egg calls it directly
// rather than going through `onSubmit`, so it needs its own spy.
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to)
}));

// `app/icons/v2` — replace the SVG barrel with a lightweight marker exposing the
// only `IconName` member the component references.
// `Button` — render the title and forward the click / tabIndex so the primary
// "get started" wiring can be verified. A `btn-<title>` test id makes the CTA
// addressable.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({
    title,
    onClick,
    tabIndex,
    id,
    variant
  }: {
    title: string;
    onClick?: () => void;
    tabIndex?: number;
    id?: string;
    variant?: string;
  }) => (
    <button
      id={id}
      data-testid={`btn-${title}`}
      data-tabindex={String(tabIndex)}
      data-variant={variant ?? 'primary'}
      onClick={onClick}
    >
      {title}
    </button>
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (props: Partial<React.ComponentProps<typeof WelcomeScreen>> = {}) =>
  render(<WelcomeScreen {...props} />);

beforeEach(() => {
  mockPlatform.isMobile = false;
  hapticLight.mockClear();
  hapticMedium.mockClear();
  mockNavigate.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WelcomeScreen', () => {
  it('renders the onboarding welcome container with its test id', () => {
    renderComponent();
    expect(screen.getByTestId('onboarding-welcome')).toBeInTheDocument();
  });

  it('renders the bread logo and the hero on the shared layout, the actions pinned in its footer', () => {
    const { container } = renderComponent();
    expect(container.querySelector('svg')).toHaveClass('w-[140px]');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('font-heading', 'text-ink');
    expect(screen.getByText('breadWalletDescription')).toHaveClass('text-muted');
    const footer = screen.getByTestId('btn-getStarted').parentElement;
    expect(footer).toHaveAttribute('data-slot', 'footer');
    expect(footer).toContainElement(document.getElementById('import-link'));
  });

  it('renders the translated heading copy across its spans', () => {
    renderComponent();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('welcome');
    expect(heading).toHaveTextContent('toLowercase');
    expect(heading).toHaveTextContent('midenWallet');
  });

  it('renders the translated description copy', () => {
    renderComponent();
    expect(screen.getByText('breadWalletDescription')).toBeInTheDocument();
  });

  it('renders the primary get-started button as focusable (tabIndex 0)', () => {
    renderComponent();
    const button = screen.getByTestId('btn-getStarted');
    expect(button).toHaveTextContent('getStarted');
    expect(button).toHaveAttribute('data-tabindex', '0');
  });

  it('renders recover-account as the secondary button under Get started', () => {
    renderComponent();
    const link = document.getElementById('import-link');
    expect(link).toHaveTextContent('recoverYourAccount');
    expect(link).toHaveAttribute('data-variant', 'secondary');
    expect(screen.getByTestId('btn-getStarted')).toHaveAttribute('data-variant', 'primary');
  });

  it('invokes onSubmit with "select-wallet-type" when get-started is clicked', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    fireEvent.click(screen.getByTestId('btn-getStarted'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-wallet-type');
  });

  it('calls onSubmit with "select-import-type" when recover is clicked (the Button owns the haptic)', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    fireEvent.click(document.getElementById('import-link')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-import-type');
  });

  it('does not throw on recover without an onSubmit handler', () => {
    renderComponent();
    expect(() => fireEvent.click(document.getElementById('import-link')!)).not.toThrow();
  });

  it('does not throw when get-started is clicked without an onSubmit handler', () => {
    renderComponent();
    expect(() => fireEvent.click(screen.getByTestId('btn-getStarted'))).not.toThrow();
  });

  it('does not fire any callback before interaction', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });
});

describe('WelcomeScreen developer unlock', () => {
  it('navigates to developer settings after 7 taps on the logo', () => {
    renderComponent();
    const logo = screen.getByTestId('onboarding-bread-logo');
    for (let i = 0; i < 7; i++) fireEvent.click(logo);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
  });

  it('does not navigate before the 7th tap', () => {
    renderComponent();
    const logo = screen.getByTestId('onboarding-bread-logo');
    for (let i = 0; i < 6; i++) fireEvent.click(logo);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('prevents text selection on the logo tap target', () => {
    renderComponent();
    const logo = screen.getByTestId('onboarding-bread-logo');
    expect(logo).toHaveClass('select-none');
  });
});
