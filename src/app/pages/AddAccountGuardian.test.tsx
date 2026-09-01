import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import AddAccountGuardian from './AddAccountGuardian';

// ---------------------------------------------------------------------------
// AddAccountGuardian is the operator picker for the add-account flow. The page
// itself only owns the submit pipeline (create → switch → home) plus the back
// affordances, so PageLayout, NavigationHeader and ChooseGuardianScreen are all
// stubbed down to the props this page actually wires up.
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
// The page hides PageLayout's toolbar, so this is the only back registration.
let mockBackHandler: (() => boolean | void) | undefined;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ children, hideToolbar }: { children: React.ReactNode; hideToolbar?: boolean }) => (
    <div data-testid="page-layout" data-hide-toolbar={String(Boolean(hideToolbar))}>
      {children}
    </div>
  )
}));

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({
    title,
    onBack,
    variant,
    titleAlign
  }: {
    title?: string;
    onBack?: () => void;
    variant?: string;
    titleAlign?: string;
  }) => (
    <div data-testid="nav-header" data-variant={variant} data-title-align={titleAlign}>
      <span data-testid="nav-title">{title}</span>
      <button type="button" data-testid="nav-back" onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('screens/onboarding/common/ChooseGuardian', () => ({
  ChooseGuardianScreen: ({
    onSubmit,
    allowCustomEndpoint,
    error,
    submitLoading
  }: {
    onSubmit: (payload: { guardianId: string; guardianEndpoint: string }) => void;
    allowCustomEndpoint?: boolean;
    error?: string | null;
    submitLoading?: boolean;
  }) => (
    <div
      data-testid="choose-guardian"
      data-allow-custom={String(Boolean(allowCustomEndpoint))}
      data-submit-loading={String(Boolean(submitLoading))}
    >
      {error ? <span role="alert">{error}</span> : null}
      <button
        data-testid="pick-guardian"
        onClick={() => onSubmit({ guardianId: 'g', guardianEndpoint: 'https://g' })}
      >
        pick
      </button>
    </div>
  )
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ createAccount: mockCreateAccount, updateCurrentAccount: mockUpdateCurrentAccount })
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
  useLocation: () => ({ historyPosition: mockHistoryPosition, pathname: '/add-account/guardian' })
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

describe('AddAccountGuardian', () => {
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

  it('hides the toolbar and leaves the heading to the picker', () => {
    render(<AddAccountGuardian />);

    expect(screen.getByTestId('page-layout')).toHaveAttribute('data-hide-toolbar', 'true');
    expect(screen.getByTestId('nav-title')).toBeEmptyDOMElement();
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-variant', 'prominent');
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-title-align', 'left');
    expect(screen.getByTestId('choose-guardian')).toHaveAttribute('data-allow-custom', 'true');
    expect(screen.getByTestId('choose-guardian')).toHaveAttribute('data-submit-loading', 'false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('creates the guardian account on the chosen endpoint, switches to it and goes home', async () => {
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });

    expect(mockCreateAccount).toHaveBeenCalledWith('guardian', undefined, 'https://g');
    expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('key-new');
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('goes home without switching when no new account turned up', async () => {
    mockCreateAccount.mockResolvedValue(undefined);
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });

    expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('marks the picker as loading and ignores re-taps while creation is in flight', async () => {
    const pending = deferred<void>();
    mockCreateAccount.mockReturnValue(pending.promise);
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });
    expect(screen.getByTestId('choose-guardian')).toHaveAttribute('data-submit-loading', 'true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.getByTestId('choose-guardian')).toHaveAttribute('data-submit-loading', 'false');
  });

  it('surfaces the Error message and stays on the page when creation fails', async () => {
    mockCreateAccount.mockRejectedValue(new Error('guardian refused'));
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('guardian refused');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('falls back to the generic message for a non-Error rejection', async () => {
    mockCreateAccount.mockRejectedValue('boom');
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('smthWentWrong');
  });

  it('lets a retry through once the failed attempt has settled', async () => {
    mockCreateAccount.mockRejectedValueOnce(new Error('guardian refused'));
    render(<AddAccountGuardian />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-guardian'));
    });

    expect(mockCreateAccount).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenCalledWith('/');
    // The retry clears the previous failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pops history from the header back chevron', () => {
    render(<AddAccountGuardian />);

    fireEvent.click(screen.getByTestId('nav-back'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('falls back home from the header when the screen was opened cold', () => {
    mockHistoryPosition = 0;
    render(<AddAccountGuardian />);

    fireEvent.click(screen.getByTestId('nav-back'));

    expect(mockNavigate).toHaveBeenCalledWith('/', 'replace');
  });

  it('consumes hardware back by running the same back handler', () => {
    render(<AddAccountGuardian />);

    let handled: boolean | void = false;
    act(() => {
      handled = mockBackHandler?.();
    });

    expect(handled).toBe(true);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
