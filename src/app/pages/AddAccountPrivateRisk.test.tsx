import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import AddAccountPrivateRisk from './AddAccountPrivateRisk';

// ---------------------------------------------------------------------------
// AddAccountPrivateRisk is the three-screen risk acknowledgment for a fully
// local private account. Its own logic is the step cursor, the guardian escape
// hatch, and the final create → switch → home pipeline; every leaf (PageLayout,
// NavigationHeader, Icon, Button) is stubbed to the props the page wires up.
// ---------------------------------------------------------------------------

interface MockAccount {
  publicKey: string;
}

const mockWalletState: { accounts: MockAccount[] } = { accounts: [{ publicKey: 'key-1' }] };

const mockCreateAccount = jest.fn<Promise<void>, [string, string?, string?]>();
const mockUpdateCurrentAccount = jest.fn<Promise<void>, [string]>();
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
let mockHistoryPosition = 1;
let mockBackHandler: (() => boolean | void) | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: new Proxy({}, { get: (_target, prop) => String(prop) })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ children, hideToolbar }: { children: React.ReactNode; hideToolbar?: boolean }) => (
    <div data-testid="page-layout" data-hide-toolbar={String(Boolean(hideToolbar))}>
      {children}
    </div>
  )
}));

// The real Button forwards `disabled` to the native <button>, which makes the
// page's own `if (isCreating) return` guards unreachable from a test click. The
// stub exposes the flag as aria-disabled/data-disabled instead — the prop wiring
// is still asserted, and the guards themselves stay exercisable.
jest.mock('components/Button', () => ({
  __esModule: true,
  Button: ({
    title,
    onClick,
    disabled,
    isLoading,
    variant,
    'data-testid': testId
  }: {
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
    variant?: string;
    'data-testid'?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      data-variant={variant}
      data-loading={String(Boolean(isLoading))}
      aria-disabled={Boolean(disabled)}
      onClick={onClick}
    >
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, onBack }: { title?: string; onBack?: () => void }) => (
    <div data-testid="nav-header">
      <span data-testid="nav-title">{title}</span>
      <button type="button" data-testid="nav-back" onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ createAccount: mockCreateAccount, updateCurrentAccount: mockUpdateCurrentAccount })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandler = handler;
  }
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    <Selected,>(selector: (state: typeof mockWalletState) => Selected): Selected => selector(mockWalletState),
    { getState: () => mockWalletState }
  )
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  goBack: () => mockGoBack(),
  HistoryAction: { Push: 'push', Replace: 'replace' },
  useLocation: () => ({ historyPosition: mockHistoryPosition, pathname: '/add-account/private' })
}));

jest.mock('screens/onboarding/types', () => ({
  WalletType: { OffChain: 'off-chain', Guardian: 'guardian', OnChain: 'on-chain' }
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const continueButton = () => screen.getByTestId('local-risk-continue');
const guardianButton = () => screen.getByTestId('local-risk-use-guardian');

/** Advances to the final risk screen (two "I understand" taps). */
const advanceToLastStep = () => {
  fireEvent.click(continueButton());
  fireEvent.click(continueButton());
};

describe('AddAccountPrivateRisk', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWalletState.accounts = [{ publicKey: 'key-1' }];
    mockHistoryPosition = 1;
    mockBackHandler = undefined;
    mockCreateAccount.mockImplementation(() => {
      mockWalletState.accounts = [...mockWalletState.accounts, { publicKey: 'key-new' }];
      return Promise.resolve();
    });
    mockUpdateCurrentAccount.mockResolvedValue(undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('step progression', () => {
    it('opens on the first risk screen with the toolbar hidden', () => {
      render(<AddAccountPrivateRisk />);

      expect(screen.getByTestId('page-layout')).toHaveAttribute('data-hide-toolbar', 'true');
      expect(screen.getByTestId('nav-title')).toHaveTextContent('fullyPrivateRecovery');
      expect(screen.getByText('localRiskStepCounter')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep1Title');
      expect(screen.getByText('localRiskStep1Body')).toBeInTheDocument();
      expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Warning');
      expect(continueButton()).toHaveTextContent('iUnderstand');
      expect(guardianButton()).toHaveTextContent('useGuardianInstead');
    });

    it('walks all three screens and titles the last CTA "create account"', () => {
      render(<AddAccountPrivateRisk />);

      fireEvent.click(continueButton());
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep2Title');
      expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'Key');
      expect(continueButton()).toHaveTextContent('iUnderstand');

      fireEvent.click(continueButton());
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep3Title');
      expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'EyeOff');
      expect(continueButton()).toHaveTextContent('createAccount');
      expect(mockCreateAccount).not.toHaveBeenCalled();
      expect(hapticLight).toHaveBeenCalledTimes(2);
    });
  });

  describe('back', () => {
    it('steps backwards through the risk screens', () => {
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      fireEvent.click(screen.getByTestId('nav-back'));

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep2Title');
      expect(mockGoBack).not.toHaveBeenCalled();
    });

    it('leaves the flow from the first screen', () => {
      render(<AddAccountPrivateRisk />);

      fireEvent.click(screen.getByTestId('nav-back'));

      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('falls back home when the screen was opened cold', () => {
      mockHistoryPosition = 0;
      render(<AddAccountPrivateRisk />);

      fireEvent.click(screen.getByTestId('nav-back'));

      expect(mockNavigate).toHaveBeenCalledWith('/', 'replace');
    });

    it('consumes hardware back and runs the same handler', () => {
      render(<AddAccountPrivateRisk />);
      fireEvent.click(continueButton());

      let handled: boolean | void = false;
      act(() => {
        handled = mockBackHandler?.();
      });

      expect(handled).toBe(true);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep1Title');
    });

    it('is inert while the account is being created', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });
      fireEvent.click(screen.getByTestId('nav-back'));

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('localRiskStep3Title');
      expect(mockGoBack).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    });
  });

  describe('guardian escape hatch', () => {
    it('routes to the operator picker', () => {
      render(<AddAccountPrivateRisk />);

      fireEvent.click(guardianButton());

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/add-account/guardian');
    });

    it('is inert while the account is being created', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });
      fireEvent.click(guardianButton());

      expect(mockNavigate).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    });
  });

  describe('account creation', () => {
    it('creates the off-chain account, switches to it and goes home', async () => {
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });

      expect(mockCreateAccount).toHaveBeenCalledWith('off-chain');
      expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('key-new');
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('goes home without switching when no new account turned up', async () => {
      mockCreateAccount.mockResolvedValue(undefined);
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });

      expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('shows the loading state, disables both CTAs and ignores re-taps', async () => {
      const pending = deferred<void>();
      mockCreateAccount.mockReturnValue(pending.promise);
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });

      expect(continueButton()).toHaveAttribute('data-loading', 'true');
      expect(continueButton()).toHaveAttribute('aria-disabled', 'true');
      expect(guardianButton()).toHaveAttribute('aria-disabled', 'true');

      await act(async () => {
        fireEvent.click(continueButton());
      });
      expect(mockCreateAccount).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      expect(continueButton()).toHaveAttribute('data-loading', 'false');
    });

    it('surfaces the Error message and stays on the last screen', async () => {
      mockCreateAccount.mockRejectedValue(new Error('vault is locked'));
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });

      expect(screen.getByRole('alert')).toHaveTextContent('vault is locked');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('falls back to the generic message for a non-Error rejection', async () => {
      mockCreateAccount.mockRejectedValue('boom');
      render(<AddAccountPrivateRisk />);
      advanceToLastStep();

      await act(async () => {
        fireEvent.click(continueButton());
      });

      expect(screen.getByRole('alert')).toHaveTextContent('smthWentWrong');
    });
  });
});
