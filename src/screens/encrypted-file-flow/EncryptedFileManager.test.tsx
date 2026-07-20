import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { EncryptedFileFlow, EncryptedFileManager } from './EncryptedFileManager';
import { EncryptedFileStep } from './types';

/**
 * EncryptedFileManager is a Navigator-hosted, react-hook-form-driven multi-step
 * export flow. We drive it through the exported `EncryptedFileFlow` wrapper
 * (which also exercises NavigatorWrapper + the ROUTES table) and mock every
 * module boundary so each branch is reachable deterministically:
 *   - `components/Navigator` is mocked so `cardStack`, `navigateTo`, `goBack`
 *     and `activeRoute` are fully controllable, and the mocked `Navigator`
 *     renders whatever route we hand it — this decouples the rendered step from
 *     `activeRoute`, letting us hit every `renderStep` branch (including the
 *     `WalletPassword -> null` and unknown-route `<></>` branches) while the
 *     surrounding <form> stays mounted.
 *   - `react-hook-form`'s `useForm` is mocked so `watch`, `formState`,
 *     `clearErrors`, `setError`, `setValue` and the submit handler are steered
 *     by hand — this is the only way to reach `onSubmit`'s `isSubmitting`
 *     early-return and its `clearErrors` try/catch (real RHF never throws
 *     there).
 *   - The three step/drawer child components, the drawer primitives, the nav
 *     header, i18n, woozie navigation and the mobile back handler are all thin
 *     jest.fn()-backed harnesses.
 *
 * Note on coverage: `onAction`'s `GoBack`, `Finish` and `default` switch cases
 * are dead code — the component only ever dispatches `Navigate` and
 * `SetFormValues` actions through the rendered UI, so those three arms have no
 * reachable caller. Everything else is exercised to 100%.
 */

// ---------------------------------------------------------------------------
// Mutable control state (read lazily inside mock-factory closures).
// ---------------------------------------------------------------------------
let mockActiveRoute: { name: string } | undefined = { name: EncryptedFileStep.WalletPassword };
let mockCardStack: { name: string }[] = [{ name: EncryptedFileStep.WalletPassword }];
let mockRenderRoute: { name: string; animationIn: string; animationOut: string } = {
  name: EncryptedFileStep.ExportFilePassword,
  animationIn: 'push',
  animationOut: 'pop'
};

const navigateToMock = jest.fn();
const goBackMock = jest.fn();
const navigateMock = jest.fn();

const useMobileBackHandlerMock = jest.fn();
let capturedBackHandler: (() => boolean | void) | null = null;

// react-hook-form surface.
const registerMock = jest.fn();
const setValueMock = jest.fn();
const setErrorMock = jest.fn();
const clearErrorsMock = jest.fn();
let mockFormState: { isSubmitting: boolean } = { isSubmitting: false };
let mockWatch: Record<string, string | undefined> = { fileName: '', filePassword: '', walletPassword: '' };

// ---------------------------------------------------------------------------
// Module mocks.
// ---------------------------------------------------------------------------
jest.mock('components/Navigator', () => ({
  __esModule: true,
  useNavigator: () => ({
    navigateTo: navigateToMock,
    goBack: goBackMock,
    cardStack: mockCardStack,
    activeRoute: mockActiveRoute
  }),
  NavigatorProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="nav-provider">{children}</div>,
  Navigator: ({ renderRoute }: { renderRoute: (route: unknown, index: number) => React.ReactNode }) => (
    <div data-testid="navigator">{renderRoute(mockRenderRoute, 0)}</div>
  )
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/woozie', () => ({
  navigate: (...a: unknown[]) => navigateMock(...a)
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (cb: () => boolean | void, deps: unknown[]) => useMobileBackHandlerMock(cb, deps)
}));

jest.mock('react-hook-form', () => ({
  useForm: () => ({
    register: registerMock,
    watch: (name: string) => mockWatch[name],
    handleSubmit: (onSubmit: (values: unknown, e?: unknown) => unknown) => (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
      return onSubmit(mockWatch, e);
    },
    formState: mockFormState,
    setError: setErrorMock,
    clearErrors: clearErrorsMock,
    setValue: setValueMock
  })
}));

// vaul drawer primitives — always render children plus probes to fire
// `onOpenChange` with both `false` and `true`, and surface `open`.
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
      <button data-testid="drawer-close" onClick={() => onOpenChange(false)} />
      <button data-testid="drawer-open" onClick={() => onOpenChange(true)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="drawer-title">{children}</h2>
}));

jest.mock('components/NavigationHeader', () => ({
  __esModule: true,
  NavigationHeader: (props: { title?: string; onBack?: () => void }) => (
    <div data-testid="nav-header">
      <span data-testid="nh-title">{props.title}</span>
      <button data-testid="nh-back" onClick={props.onBack} />
    </div>
  )
}));

jest.mock('screens/encrypted-file-flow/EncryptedWalletFileWalletPassword', () => ({
  __esModule: true,
  default: (props: {
    onGoNext: () => void;
    onGoBack: () => void;
    onPasswordChange: (value: string) => void;
    walletPassword?: string;
  }) => (
    <div data-testid="wallet-password-step">
      <span data-testid="wps-password">{props.walletPassword ?? ''}</span>
      <button data-testid="wps-next" onClick={props.onGoNext} />
      <button data-testid="wps-back" onClick={props.onGoBack} />
      <input data-testid="wps-change" onChange={e => props.onPasswordChange(e.target.value)} />
    </div>
  )
}));

jest.mock('./ExportFileSetNamePassword', () => ({
  __esModule: true,
  default: (props: {
    onGoBack: () => void;
    onGoNext: () => void;
    passwordValue: string;
    handlePasswordChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    fileName: string;
    onFileNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <div data-testid="export-password-step">
      <span data-testid="eps-password">{props.passwordValue}</span>
      <span data-testid="eps-filename">{props.fileName ?? ''}</span>
      <button data-testid="eps-back" onClick={props.onGoBack} />
      <button data-testid="eps-next" onClick={props.onGoNext} />
      <input data-testid="eps-pw-change" onChange={props.handlePasswordChange} />
      <input data-testid="eps-name-change" onChange={props.onFileNameChange} />
    </div>
  )
}));

jest.mock('./ExportFileComplete', () => ({
  __esModule: true,
  default: (props: {
    onGoBack: () => void;
    onDone: () => void;
    filePassword: string;
    fileName: string;
    walletPassword?: string;
  }) => (
    <div data-testid="export-complete-step">
      <span data-testid="ec-filepassword">{props.filePassword}</span>
      <span data-testid="ec-filename">{props.fileName ?? ''}</span>
      <span data-testid="ec-walletpassword">{props.walletPassword ?? ''}</span>
      <button data-testid="ec-back" onClick={props.onGoBack} />
      <button data-testid="ec-done" onClick={props.onDone} />
    </div>
  )
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const renderFlow = () => render(<EncryptedFileFlow />);

const setWalletStep = () => {
  mockActiveRoute = { name: EncryptedFileStep.WalletPassword };
};

const setExportStep = (renderName: string = EncryptedFileStep.ExportFilePassword) => {
  mockActiveRoute = { name: EncryptedFileStep.ExportFilePassword };
  mockRenderRoute = { name: renderName, animationIn: 'push', animationOut: 'pop' };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveRoute = { name: EncryptedFileStep.WalletPassword };
  mockCardStack = [{ name: EncryptedFileStep.WalletPassword }];
  mockRenderRoute = { name: EncryptedFileStep.ExportFilePassword, animationIn: 'push', animationOut: 'pop' };
  mockFormState = { isSubmitting: false };
  mockWatch = { fileName: '', filePassword: '', walletPassword: '' };
  clearErrorsMock.mockImplementation(() => undefined);
  capturedBackHandler = null;
  useMobileBackHandlerMock.mockImplementation((cb: () => boolean | void) => {
    capturedBackHandler = cb;
  });
});

// ---------------------------------------------------------------------------
// Wrapper wiring + wallet-password (drawer) step.
// ---------------------------------------------------------------------------
describe('EncryptedFileFlow / wallet-password step', () => {
  it('renders the localized drawer and hides the export chrome on the wallet-password step', () => {
    setWalletStep();
    renderFlow();

    expect(screen.getByTestId('nav-provider')).toBeInTheDocument();
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('encryptedWalletFile');
    expect(screen.getByTestId('wallet-password-step')).toBeInTheDocument();
    // Export chrome (header + navigator form) is hidden on the first step.
    expect(screen.queryByTestId('nav-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('navigator')).not.toBeInTheDocument();
  });

  it('forwards the current wallet password into the drawer step', () => {
    setWalletStep();
    mockWatch = { fileName: '', filePassword: '', walletPassword: 'super-secret' };
    renderFlow();
    expect(screen.getByTestId('wps-password')).toHaveTextContent('super-secret');
  });

  it('closes the flow (navigate /settings) when the drawer requests close', () => {
    setWalletStep();
    renderFlow();
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(navigateMock).toHaveBeenCalledWith('/settings');
  });

  it('does not close the flow when the drawer reports open (the !open guard)', () => {
    setWalletStep();
    renderFlow();
    fireEvent.click(screen.getByTestId('drawer-open'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the flow when the wallet-password step goes back', () => {
    setWalletStep();
    renderFlow();
    fireEvent.click(screen.getByTestId('wps-back'));
    expect(navigateMock).toHaveBeenCalledWith('/settings');
  });

  it('advances to the export-password step and collapses the drawer on next', () => {
    setWalletStep();
    renderFlow();
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByTestId('wps-next'));

    expect(navigateToMock).toHaveBeenCalledWith(EncryptedFileStep.ExportFilePassword);
    // setDrawerOpen(false) -> open collapses even though we are still on the
    // wallet-password route in this mocked-navigator setup.
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('sets the wallet-password form value on change (SetFormValues action)', () => {
    setWalletStep();
    renderFlow();
    fireEvent.change(screen.getByTestId('wps-change'), { target: { value: 'typed-pw' } });
    expect(setValueMock).toHaveBeenCalledWith('walletPassword', 'typed-pw');
  });

  it('registers the three form fields on mount', () => {
    setWalletStep();
    renderFlow();
    expect(registerMock).toHaveBeenCalledWith('fileName');
    expect(registerMock).toHaveBeenCalledWith('filePassword');
    expect(registerMock).toHaveBeenCalledWith('walletPassword');
  });
});

// ---------------------------------------------------------------------------
// Export chrome (header + form) on non-wallet-password steps.
// ---------------------------------------------------------------------------
describe('export chrome / renderStep', () => {
  it('shows the navigation header + form and keeps the drawer closed off the wallet step', () => {
    setExportStep();
    renderFlow();

    expect(screen.getByTestId('nav-header')).toBeInTheDocument();
    expect(screen.getByTestId('nh-title')).toHaveTextContent('encryptedWalletFile');
    expect(screen.getByTestId('navigator')).toBeInTheDocument();
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('treats an undefined active route as a non-wallet step (optional-chaining branch)', () => {
    mockActiveRoute = undefined;
    mockRenderRoute = { name: EncryptedFileStep.ExportFilePassword, animationIn: 'push', animationOut: 'pop' };
    renderFlow();
    expect(screen.getByTestId('nav-header')).toBeInTheDocument();
    expect(screen.getByTestId('export-password-step')).toBeInTheDocument();
  });

  it('closes the flow when the navigation header back button is pressed', () => {
    setExportStep();
    renderFlow();
    fireEvent.click(screen.getByTestId('nh-back'));
    expect(navigateMock).toHaveBeenCalledWith('/settings');
  });

  it('renders nothing for the WalletPassword route inside the navigator', () => {
    setExportStep(EncryptedFileStep.WalletPassword);
    renderFlow();
    // Navigator is present but its rendered step (null) contributes no children.
    expect(screen.getByTestId('navigator')).toBeEmptyDOMElement();
    expect(screen.queryByTestId('export-password-step')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-complete-step')).not.toBeInTheDocument();
  });

  it('renders the export-password step and wires its callbacks', () => {
    setExportStep(EncryptedFileStep.ExportFilePassword);
    mockWatch = { fileName: 'wallet-backup', filePassword: 'p@ss', walletPassword: 'wpw' };
    renderFlow();

    expect(screen.getByTestId('export-password-step')).toBeInTheDocument();
    expect(screen.getByTestId('eps-password')).toHaveTextContent('p@ss');
    expect(screen.getByTestId('eps-filename')).toHaveTextContent('wallet-backup');

    // Back -> goBack.
    fireEvent.click(screen.getByTestId('eps-back'));
    expect(goBackMock).toHaveBeenCalledTimes(1);

    // Next -> navigate to the complete step.
    fireEvent.click(screen.getByTestId('eps-next'));
    expect(navigateToMock).toHaveBeenCalledWith(EncryptedFileStep.ExportFileComplete);

    // Password change -> SetFormValues -> setValue('filePassword', ...).
    fireEvent.change(screen.getByTestId('eps-pw-change'), { target: { value: 'new-file-pw' } });
    expect(setValueMock).toHaveBeenCalledWith('filePassword', 'new-file-pw');

    // File-name change -> SetFormValues -> setValue('fileName', ...).
    fireEvent.change(screen.getByTestId('eps-name-change'), { target: { value: 'renamed' } });
    expect(setValueMock).toHaveBeenCalledWith('fileName', 'renamed');
  });

  it('falls back to empty strings for an unset file password / name (?? branch)', () => {
    setExportStep(EncryptedFileStep.ExportFilePassword);
    mockWatch = { fileName: undefined, filePassword: undefined, walletPassword: undefined };
    renderFlow();
    expect(screen.getByTestId('eps-password')).toHaveTextContent('');
    expect(screen.getByTestId('eps-filename')).toHaveTextContent('');
  });

  it('renders the export-complete step and wires its callbacks', () => {
    setExportStep(EncryptedFileStep.ExportFileComplete);
    mockWatch = { fileName: 'my-file', filePassword: 'fp', walletPassword: 'wp' };
    renderFlow();

    expect(screen.getByTestId('export-complete-step')).toBeInTheDocument();
    expect(screen.getByTestId('ec-filepassword')).toHaveTextContent('fp');
    expect(screen.getByTestId('ec-filename')).toHaveTextContent('my-file');
    expect(screen.getByTestId('ec-walletpassword')).toHaveTextContent('wp');

    // Back -> goBack.
    fireEvent.click(screen.getByTestId('ec-back'));
    expect(goBackMock).toHaveBeenCalledTimes(1);

    // Done -> onClose -> navigate('/settings').
    fireEvent.click(screen.getByTestId('ec-done'));
    expect(navigateMock).toHaveBeenCalledWith('/settings');
  });

  it('falls back to empty strings for an unset complete-step password (?? branch)', () => {
    setExportStep(EncryptedFileStep.ExportFileComplete);
    mockWatch = { fileName: undefined, filePassword: undefined, walletPassword: undefined };
    renderFlow();
    expect(screen.getByTestId('ec-filepassword')).toHaveTextContent('');
    expect(screen.getByTestId('ec-walletpassword')).toHaveTextContent('');
  });

  it('renders the empty default branch for an unknown route name', () => {
    setExportStep('TotallyUnknownStep');
    renderFlow();
    expect(screen.getByTestId('navigator')).toBeEmptyDOMElement();
    expect(screen.queryByTestId('export-password-step')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-complete-step')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mobile back handler branches.
// ---------------------------------------------------------------------------
describe('mobile back handler', () => {
  it('pops the navigator when the card stack has more than one entry', () => {
    mockCardStack = [{ name: EncryptedFileStep.WalletPassword }, { name: EncryptedFileStep.ExportFilePassword }];
    renderFlow();

    let result: boolean | void;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the whole flow on the first step', () => {
    mockCardStack = [{ name: EncryptedFileStep.WalletPassword }];
    renderFlow();

    let result: boolean | void;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(goBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/settings');
  });
});

// ---------------------------------------------------------------------------
// Form submit (onSubmit try/catch + isSubmitting guard).
// ---------------------------------------------------------------------------
describe('form submission', () => {
  const submitForm = async (container: HTMLElement) => {
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });
  };

  it('clears the root error on a normal submit', async () => {
    setExportStep();
    const { container } = renderFlow();
    await submitForm(container);
    expect(clearErrorsMock).toHaveBeenCalledWith('root');
    expect(setErrorMock).not.toHaveBeenCalled();
  });

  it('is a no-op while a submission is already in flight', async () => {
    mockFormState = { isSubmitting: true };
    setExportStep();
    const { container } = renderFlow();
    await submitForm(container);
    expect(clearErrorsMock).not.toHaveBeenCalled();
  });

  it('surfaces a thrown error with a message as a manual root error', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    clearErrorsMock.mockImplementation(() => {
      throw new Error('clear failed');
    });
    setExportStep();
    const { container } = renderFlow();
    await submitForm(container);
    expect(setErrorMock).toHaveBeenCalledWith('root', { type: 'manual', message: 'clear failed' });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs but does not set a root error when the thrown error has no message', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    clearErrorsMock.mockImplementation(() => {
      throw new Error('');
    });
    setExportStep();
    const { container } = renderFlow();
    await submitForm(container);
    expect(setErrorMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Named export renders on its own (inside the mocked navigator context).
// ---------------------------------------------------------------------------
describe('EncryptedFileManager (named export)', () => {
  it('renders directly without the wrapper provider', () => {
    setWalletStep();
    render(<EncryptedFileManager />);
    expect(screen.getByTestId('encrypted-file-manager-flow')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('encryptedWalletFile');
  });
});
