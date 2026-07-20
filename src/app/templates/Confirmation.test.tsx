import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import Confirmation from './Confirmation';

// ---------------------------------------------------------------------------
// Mocks.
//
// Confirmation.tsx is a purely presentational success screen. Every branch is
// driven by two inputs: the `delegated` prop and `useAppEnv().fullPage`. We stub
// each collaborator so the only code executed (and measured) is Confirmation.tsx
// itself.
//   - `react-i18next`: identity translator so assertions match raw keys.
//   - `app/env`: `fullPage` is a module-level toggle the tests script per-case.
//   - `lib/ui/useTippy`: capture the tippy props the component computes and hand
//     back a real ref object so `<span ref={helpRef}>` works.
//   - `components/Button` / `lib/woozie/Link`: thin DOM stand-ins that forward
//     the props Confirmation wires (variant, className, data-testid, onClick,
//     `to`) so the empty `onClick` handler and the "/" navigation are assertable.
// The two SVG icon imports resolve to the repo's `svgMock` (the string "svg"),
// which React renders as a plain <svg> element — no explicit mock needed.
// ---------------------------------------------------------------------------

// i18n: echo the key back so text assertions read the raw translation keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `fullPage` toggles the footer margin/height branches; scripted per test.
let mockFullPage = false;
jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: mockFullPage })
}));

// Capture the props passed to useTippy and return a usable ref object.
const mockUseTippy = jest.fn();
jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: (props: unknown) => mockUseTippy(props)
}));

// Button stub: forward the props Confirmation sets so we can assert them and
// drive the (empty) onClick handler by clicking.
jest.mock('components/Button', () => ({
  __esModule: true,
  Button: ({
    children,
    variant,
    className,
    onClick,
    ...rest
  }: {
    children?: React.ReactNode;
    variant?: string;
    className?: string;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button
      onClick={onClick}
      className={className}
      data-variant={variant}
      data-testid={rest['data-testid']}
    >
      {children}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// Link stub: expose the `to` target and render children (the Button) inside.
jest.mock('lib/woozie/Link', () => ({
  __esModule: true,
  default: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <a data-testid="home-link" data-to={to}>
      {children}
    </a>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFullPage = false;
  mockUseTippy.mockReturnValue({ current: null });
});

describe('Confirmation', () => {
  it('renders the shared success copy and wires the info tooltip', () => {
    render(<Confirmation delegated={false} testId="Confirmation/Home" />);

    // Static copy present regardless of branch.
    expect(screen.getByText('transactionInitiated')).toBeInTheDocument();
    expect(screen.getByText('home')).toBeInTheDocument();

    // useTippy receives the proof-generation tooltip config the component builds.
    expect(mockUseTippy).toHaveBeenCalledTimes(1);
    expect(mockUseTippy).toHaveBeenCalledWith({
      trigger: 'mouseenter',
      hideOnClick: false,
      content: 'proofGenerationTab',
      animation: 'shift-away-subtle'
    });
  });

  it('shows the delegated variant of every conditional string when delegated', () => {
    render(<Confirmation delegated={true} testId="Confirmation/Home" />);

    expect(screen.getByText('transactionDelegated')).toBeInTheDocument();
    expect(screen.getByText('fastTransaction')).toBeInTheDocument();
    expect(screen.getByText('fastTransactionDescription')).toBeInTheDocument();

    // The non-delegated strings must NOT appear.
    expect(screen.queryByText('transactionBackground')).not.toBeInTheDocument();
    expect(screen.queryByText('speedUpTransaction')).not.toBeInTheDocument();
    expect(screen.queryByText('openedNewTab')).not.toBeInTheDocument();
  });

  it('shows the non-delegated (background) variant of every conditional string', () => {
    render(<Confirmation delegated={false} testId="Confirmation/Home" />);

    expect(screen.getByText('transactionBackground')).toBeInTheDocument();
    expect(screen.getByText('speedUpTransaction')).toBeInTheDocument();
    expect(screen.getByText('openedNewTab')).toBeInTheDocument();

    expect(screen.queryByText('transactionDelegated')).not.toBeInTheDocument();
    expect(screen.queryByText('fastTransaction')).not.toBeInTheDocument();
    expect(screen.queryByText('fastTransactionDescription')).not.toBeInTheDocument();
  });

  it('forwards the testId and Ghost variant to the home Button inside a Link to "/"', () => {
    const { container } = render(<Confirmation delegated={false} testId="Confirmation/Home" />);

    const link = screen.getByTestId('home-link');
    expect(link).toHaveAttribute('data-to', '/');

    const button = screen.getByTestId('Confirmation/Home');
    // The Button lives inside the Link.
    expect(link).toContainElement(button);
    expect(button).toHaveAttribute('data-variant', 'ghost');
    expect(button).toHaveTextContent('home');

    // Clicking exercises the (empty) onClick handler without throwing.
    expect(() => fireEvent.click(button)).not.toThrow();

    // The two icon imports render as plain <svg> elements via svgMock.
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('applies the compact footer classes/height when NOT full page', () => {
    const { container } = render(<Confirmation delegated={false} testId="Confirmation/Home" />);

    const footer = container.querySelector('.flex.flex-col.justify-end') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(footer.className).toContain('mb-2');
    expect(footer.className).not.toContain('mb-8');
    expect(footer.style.height).toBe('8.5rem');
  });

  it('applies the full-page footer classes/height when full page', () => {
    mockFullPage = true;
    const { container } = render(<Confirmation delegated={true} testId="Confirmation/Home" />);

    const footer = container.querySelector('.flex.flex-col.justify-end') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(footer.className).toContain('mb-8');
    expect(footer.className).not.toContain('mb-2');
    expect(footer.style.height).toBe('12.5rem');
  });
});
