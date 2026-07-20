import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { PageLayoutSelectors } from './PageLayout.selectors';
import PageLayout from './PageLayout';

// ---------------------------------------------------------------------------
// Mutable mock state (all `mock`-prefixed so jest's factory hoisting allows the
// factories below to close over them). Factories reference these lazily via
// arrow wrappers so nothing is evaluated at factory-definition time.
// ---------------------------------------------------------------------------

let mockIsMobile = false;
let mockIsDesktop = false;

let mockLocation: { historyPosition: number; pathname: string } = { historyPosition: 0, pathname: '/' };

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

const mockOnBack = jest.fn();
const mockCleanup = jest.fn();
let capturedBackHandler: (() => void) | null = null;
const mockRegisterBackHandler = jest.fn((handler: () => void) => {
  capturedBackHandler = handler;
  return mockCleanup;
});

let mockEnv: Record<string, unknown> = {};
const setEnv = (overrides: Record<string, unknown> = {}) => {
  mockEnv = {
    fullPage: false,
    sidePanel: false,
    compact: false,
    registerBackHandler: mockRegisterBackHandler,
    onBack: mockOnBack,
    ...overrides
  };
};

const mockSetOnboardingCompleted = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile,
  isDesktop: () => mockIsDesktop
}));

jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => mockLocation,
  HistoryAction: { Replace: 'Replace', Push: 'Push' }
}));

jest.mock('app/env', () => ({
  useAppEnv: () => mockEnv
}));

jest.mock('app/hooks/useOnboardingProgress', () => ({
  useOnboardingProgress: () => ({
    onboardingCompleted: false,
    setOnboardingCompleted: (...args: unknown[]) => mockSetOnboardingCompleted(...args)
  })
}));

// DocBg mutates document.documentElement classList — not under test, mock away.
jest.mock('app/a11y/DocBg', () => ({
  __esModule: true,
  default: () => null
}));

// ChangelogOverlay pulls in a CSS module + storage; not under test.
jest.mock('./PageLayout/ChangelogOverlay/ChangelogOverlay', () => ({
  ChangelogOverlay: () => <div data-testid="changelog-overlay" />
}));

jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));

jest.mock('app/icons/v2', () => ({
  Icon: (props: { name?: string }) => <span data-testid="icon" data-name={props.name} />,
  IconName: { Close: 'Close' }
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {children}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// ---------------------------------------------------------------------------
// IntersectionObserver mock
// ---------------------------------------------------------------------------

let mockIOInstances: MockIntersectionObserver[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();

  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    mockIOInstances.push(this);
  }

  trigger(entries: unknown[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

const getContainerEl = (container: HTMLElement): HTMLElement =>
  container.querySelector('div.m-auto') as HTMLElement;

describe('PageLayout', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = false;
    mockIsDesktop = false;
    mockLocation = { historyPosition: 0, pathname: '/' };
    capturedBackHandler = null;
    mockIOInstances = [];
    setEnv();
    // jsdom has no IntersectionObserver; install our controllable one by default.
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  // -- container sizing branches ------------------------------------------

  it('uses full width/height on mobile', () => {
    mockIsMobile = true;
    const { container } = render(<PageLayout>content</PageLayout>);
    const el = getContainerEl(container);
    expect(el.style.height).toBe('100%');
    expect(el.style.width).toBe('100%');
    expect(el.style.maxWidth).toBe('');
  });

  it('uses responsive max-width on desktop', () => {
    mockIsDesktop = true;
    const { container } = render(<PageLayout>content</PageLayout>);
    const el = getContainerEl(container);
    expect(el.style.height).toBe('100%');
    expect(el.style.width).toBe('100%');
    expect(el.style.maxWidth).toBe('600px');
  });

  it('uses full size in the extension side panel', () => {
    setEnv({ sidePanel: true });
    const { container } = render(<PageLayout>content</PageLayout>);
    const el = getContainerEl(container);
    expect(el.style.height).toBe('100%');
    expect(el.style.width).toBe('100%');
    expect(el.style.maxWidth).toBe('');
  });

  it('uses fixed full-page size and the full-page ContentPaper variant', () => {
    setEnv({ fullPage: true });
    const { container } = render(<PageLayout>content</PageLayout>);
    const el = getContainerEl(container);
    expect(el.style.height).toBe('640px');
    expect(el.style.width).toBe('600px');
    // Full-page ContentPaper wraps children in a div with a minHeight style.
    const inner = container.querySelector('div[style*="min-height"]') as HTMLElement;
    expect(inner).toBeTruthy();
    expect(inner.style.minHeight).toBe('20rem');
  });

  it('uses fixed popup size when not full-page/side-panel/mobile/desktop', () => {
    const { container } = render(<PageLayout>content</PageLayout>);
    const el = getContainerEl(container);
    expect(el.style.height).toBe('600px');
    expect(el.style.width).toBe('360px');
  });

  it('applies the provided contentContainerStyle', () => {
    const { container } = render(
      <PageLayout contentContainerStyle={{ background: 'red' }}>content</PageLayout>
    );
    const styled = container.querySelector('div[style*="background"]') as HTMLElement;
    expect(styled).toBeTruthy();
    expect(styled.style.background).toBe('red');
  });

  it('renders children and the changelog overlay', () => {
    render(
      <PageLayout>
        <span data-testid="child">hi</span>
      </PageLayout>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByTestId('changelog-overlay')).toBeInTheDocument();
  });

  // -- Suspense fallback (SpinnerSection) ---------------------------------

  it('shows the spinner fallback while children suspend', () => {
    const Suspending: React.FC = () => {
      throw new Promise<void>(() => {});
    };
    render(
      <PageLayout hideToolbar>
        <Suspending />
      </PageLayout>
    );
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  // -- toolbar visibility --------------------------------------------------

  it('hides the toolbar when hideToolbar is set', () => {
    mockLocation = { historyPosition: 2, pathname: '/foo' };
    render(<PageLayout hideToolbar>content</PageLayout>);
    expect(screen.queryByTestId(PageLayoutSelectors.BackButton)).not.toBeInTheDocument();
    // registerBackHandler lives inside the Toolbar, which isn't rendered.
    expect(mockRegisterBackHandler).not.toHaveBeenCalled();
  });

  it('renders the toolbar (with back button) by default', () => {
    mockLocation = { historyPosition: 3, pathname: '/foo' };
    render(<PageLayout>content</PageLayout>);
    expect(screen.getByTestId(PageLayoutSelectors.BackButton)).toBeInTheDocument();
    expect(mockRegisterBackHandler).toHaveBeenCalledTimes(1);
  });

  // -- back button visibility branches ------------------------------------

  it('hides the back button on home with no history and no step', () => {
    mockLocation = { historyPosition: 0, pathname: '/' };
    render(<PageLayout hasBackAction={false}>content</PageLayout>);
    expect(screen.queryByTestId(PageLayoutSelectors.BackButton)).not.toBeInTheDocument();
  });

  it('shows the back button when not on home even without history', () => {
    mockLocation = { historyPosition: 0, pathname: '/settings' };
    render(<PageLayout>content</PageLayout>);
    expect(screen.getByTestId(PageLayoutSelectors.BackButton)).toBeInTheDocument();
  });

  it('shows the back button via step even on home with no history', () => {
    mockLocation = { historyPosition: 0, pathname: '/' };
    render(
      <PageLayout hasBackAction={false} step={2} setStep={jest.fn()}>
        content
      </PageLayout>
    );
    expect(screen.getByTestId(PageLayoutSelectors.BackButton)).toBeInTheDocument();
  });

  // -- back button click behaviour ----------------------------------------

  it('calls onBack when the back button is clicked without a step', () => {
    mockLocation = { historyPosition: 2, pathname: '/foo' };
    render(<PageLayout>content</PageLayout>);
    fireEvent.click(screen.getByTestId(PageLayoutSelectors.BackButton));
    expect(mockOnBack).toHaveBeenCalledTimes(1);
  });

  it('steps back when the back button is clicked with a step and setStep', () => {
    const setStep = jest.fn();
    mockLocation = { historyPosition: 0, pathname: '/' };
    render(
      <PageLayout step={2} setStep={setStep}>
        content
      </PageLayout>
    );
    fireEvent.click(screen.getByTestId(PageLayoutSelectors.BackButton));
    expect(setStep).toHaveBeenCalledWith(1);
    expect(mockOnBack).not.toHaveBeenCalled();
  });

  it('does nothing on step-back when setStep is missing', () => {
    mockLocation = { historyPosition: 0, pathname: '/' };
    render(<PageLayout step={2}>content</PageLayout>);
    // onClick resolves to onStepBack because step is truthy, but the guard
    // (step && setStep && step > 0) short-circuits with setStep undefined.
    fireEvent.click(screen.getByTestId(PageLayoutSelectors.BackButton));
    expect(mockSetOnboardingCompleted).not.toHaveBeenCalled();
    expect(mockOnBack).not.toHaveBeenCalled();
  });

  // -- registered hardware back handler -----------------------------------

  it('registered back handler calls goBack when there is history', () => {
    mockLocation = { historyPosition: 5, pathname: '/foo' };
    render(<PageLayout>content</PageLayout>);
    expect(capturedBackHandler).toBeInstanceOf(Function);
    act(() => {
      capturedBackHandler!();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('registered back handler navigates home when off-home with no history', () => {
    mockLocation = { historyPosition: 0, pathname: '/deep' };
    render(<PageLayout>content</PageLayout>);
    act(() => {
      capturedBackHandler!();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/', 'Replace');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('registered back handler does nothing on home with no history', () => {
    mockLocation = { historyPosition: 0, pathname: '/' };
    render(<PageLayout>content</PageLayout>);
    act(() => {
      capturedBackHandler!();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('runs the registerBackHandler cleanup on unmount', () => {
    mockLocation = { historyPosition: 1, pathname: '/foo' };
    const { unmount } = render(<PageLayout>content</PageLayout>);
    unmount();
    expect(mockCleanup).toHaveBeenCalled();
  });

  // -- IntersectionObserver effect ----------------------------------------

  it('observes the toolbar and updates on intersection entries', () => {
    mockLocation = { historyPosition: 1, pathname: '/foo' };
    render(<PageLayout>content</PageLayout>);
    expect(mockIOInstances).toHaveLength(1);
    const observer = mockIOInstances[0];
    expect(observer.observe).toHaveBeenCalledTimes(1);

    // Sticked: boundingClientRect.y < rootBounds.y  -> setSticked(true)
    act(() => {
      observer.trigger([{ boundingClientRect: { y: -5 }, rootBounds: { y: 0 } }]);
    });
    // Not sticked: boundingClientRect.y >= rootBounds.y -> setSticked(false)
    act(() => {
      observer.trigger([{ boundingClientRect: { y: 10 }, rootBounds: { y: 0 } }]);
    });
    // No entry -> early return, no throw.
    act(() => {
      observer.trigger([]);
    });
    expect(screen.getByTestId(PageLayoutSelectors.BackButton)).toBeInTheDocument();
  });

  it('unobserves the toolbar on unmount', () => {
    const { unmount } = render(<PageLayout>content</PageLayout>);
    const observer = mockIOInstances[0];
    unmount();
    expect(observer.unobserve).toHaveBeenCalledTimes(1);
  });

  it('skips IntersectionObserver setup when the API is unavailable', () => {
    delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    mockLocation = { historyPosition: 1, pathname: '/foo' };
    render(<PageLayout>content</PageLayout>);
    expect(mockIOInstances).toHaveLength(0);
    expect(screen.getByTestId(PageLayoutSelectors.BackButton)).toBeInTheDocument();
  });

  // -- toolbar content branches -------------------------------------------

  it('renders pageTitle and advancedSettingsSection', () => {
    render(
      <PageLayout
        pageTitle={<span data-testid="title">Title</span>}
        advancedSettingsSection={<span data-testid="advanced">adv</span>}
      >
        content
      </PageLayout>
    );
    expect(screen.getByTestId('title')).toBeInTheDocument();
    expect(screen.getByTestId('advanced')).toBeInTheDocument();
  });

  it('omits pageTitle when not provided', () => {
    render(<PageLayout>content</PageLayout>);
    // Only the changelog overlay + toolbar render; no title node.
    expect(screen.queryByTestId('title')).not.toBeInTheDocument();
  });

  it('applies a custom titleContainerClassName', () => {
    const { container } = render(
      <PageLayout titleContainerClassName="custom-title-class">content</PageLayout>
    );
    expect(container.querySelector('.custom-title-class')).toBeTruthy();
  });

  it('falls back to the default mx-4 title container class', () => {
    const { container } = render(<PageLayout>content</PageLayout>);
    expect(container.querySelector('.mx-4')).toBeTruthy();
  });

  // -- skip button ---------------------------------------------------------

  it('does not render the skip button by default', () => {
    render(<PageLayout>content</PageLayout>);
    expect(screen.queryByText('skip')).not.toBeInTheDocument();
  });

  it('renders the skip button and completes onboarding when clicked', () => {
    render(<PageLayout skip>content</PageLayout>);
    const skipButton = screen.getByText('skip');
    expect(skipButton).toBeInTheDocument();
    fireEvent.click(skipButton);
    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true);
  });

  // -- padding branch (mobile/desktop vs popup) ---------------------------

  it('uses larger toolbar padding on mobile', () => {
    mockIsMobile = true;
    const { container } = render(<PageLayout>content</PageLayout>);
    const padded = container.querySelector('div[style*="padding-top: 24px"]');
    expect(padded).toBeTruthy();
  });

  it('uses compact toolbar padding on the extension popup', () => {
    const { container } = render(<PageLayout>content</PageLayout>);
    const padded = container.querySelector('div[style*="padding-top: 14px"]');
    expect(padded).toBeTruthy();
  });
});
