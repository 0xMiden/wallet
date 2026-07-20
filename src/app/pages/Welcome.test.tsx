import React from 'react';

import { render, act } from '@testing-library/react';

import { OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

import Welcome from './Welcome';

// ---------------------------------------------------------------------------
// Welcome.tsx is the onboarding state machine: it owns every piece of in-memory
// onboarding state (seed, password, wallet type, protection method, biometric
// bookkeeping) and translates `onAction(...)` events + URL hash changes into
// navigation + state transitions. It renders exactly one child, `OnboardingFlow`
// (from screens/onboarding/navigator), which we stub to a probe that captures
// the props Welcome forwards and, crucially, exposes the `onAction` callback so
// each test can drive a specific branch. Every leaf dependency (router, store,
// Miden context, analytics, platform detection, native secure-storage/biometric
// dynamic imports, bip39, mobile back handler, fonts gate) is mocked so the test
// exercises ONLY Welcome.tsx's own branching.
// ---------------------------------------------------------------------------

// Latest props handed to the stubbed OnboardingFlow (re-read after every render
// so `onAction` always reflects the component's current closure/state).
const mockFlowProps: { current: any } = { current: null };
jest.mock('screens/onboarding/navigator', () => ({
  OnboardingFlow: (props: any) => {
    mockFlowProps.current = props;
    return <div data-testid="onboarding-flow" data-step={props.step} />;
  }
}));

// AwaitFonts wraps children behind a suspense font-load gate; render children
// straight through so the flow probe mounts synchronously.
jest.mock('app/a11y/AwaitFonts', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

// Router: `navigate` is a spy; `useLocation` returns a controllable hash so we
// can simulate the browser landing on / reloading each onboarding route.
let mockHash = '';
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: any[]) => mockNavigate(...args),
  useLocation: () => ({ hash: mockHash })
}));

// Platform detection as jest.fn()s so a test can flip mobile/desktop per-call.
const mockIsMobileFn = jest.fn();
const mockIsDesktopFn = jest.fn();
jest.mock('lib/platform', () => ({
  isMobile: (...a: any[]) => mockIsMobileFn(...a),
  isDesktop: (...a: any[]) => mockIsDesktopFn(...a)
}));

// Native hardware-security probes reached via dynamic import().
const mockDesktopHW = jest.fn();
const mockBiometricHW = jest.fn();
jest.mock('lib/desktop/secure-storage', () => ({
  isHardwareSecurityAvailable: (...a: any[]) => mockDesktopHW(...a)
}));
jest.mock('lib/biometric', () => ({
  isHardwareSecurityAvailable: (...a: any[]) => mockBiometricHW(...a)
}));

// Chrome side-panel handoff availability (captured once via useMemo at mount).
let mockCanHandoff = false;
jest.mock('lib/extension/side-panel-handoff', () => ({
  canHandoffToSidePanel: () => mockCanHandoff
}));

// Miden context + store + intercom sync.
const mockRegisterWallet = jest.fn();
const mockImportWalletFromClient = jest.fn();
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    registerWallet: (...a: any[]) => mockRegisterWallet(...a),
    importWalletFromClient: (...a: any[]) => mockImportWalletFromClient(...a)
  })
}));

const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  putToStorage: (...a: any[]) => mockPutToStorage(...a)
}));

const mockSyncFromBackend = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: any) => selector({ syncFromBackend: mockSyncFromBackend })
}));

const mockFetchState = jest.fn();
jest.mock('lib/store/hooks/useIntercomSync', () => ({
  fetchStateFromBackend: (...a: any[]) => mockFetchState(...a)
}));

// Analytics: spy on trackEvent, provide the two categories the component reads.
const mockTrackEvent = jest.fn();
jest.mock('lib/analytics', () => ({
  useAnalytics: () => ({ trackEvent: mockTrackEvent }),
  AnalyticsEventCategory: { ButtonPress: 'button-press', FormSubmit: 'form-submit' }
}));

const mockSeedWalletPrompt = jest.fn();
jest.mock('lib/wallet-prompts', () => ({
  seedWalletPrompt: (...a: any[]) => mockSeedWalletPrompt(...a),
  WalletPromptType: { VerifySeedPhrase: 'verify-seed-phrase' }
}));

// formatMnemonic pulls in heavy defaults; a passthrough is all Welcome needs.
jest.mock('app/defaults', () => ({
  formatMnemonic: (m: string) => m
}));

// Deterministic 12-word mnemonic so seed generation is assertable.
jest.mock('bip39', () => ({
  generateMnemonic: () => 'aa bb cc dd ee ff gg hh ii jj kk ll'
}));
jest.mock('bip39/src/wordlists/english.json', () => ['aa', 'bb', 'cc'], { virtual: true });

// Capture the latest registered mobile back handler so tests can invoke it.
const mockBackHandlerRef: { current: (() => boolean | void) | null } = { current: null };
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandlerRef.current = handler;
  }
}));

// GUARDIAN_URL_STORAGE_KEY is a plain string constant — keep the real value.
jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

// WalletStatus is a tiny numeric enum used only to detect the Ready state.
jest.mock('lib/shared/types', () => ({
  WalletStatus: { Idle: 0, Locked: 1, Ready: 2 }
}));

const READY = 2;
const IDLE = 0;

// --- Harness helpers -------------------------------------------------------

let rerenderFn: (ui: React.ReactElement) => void;

async function renderWelcome() {
  await act(async () => {
    const result = render(<Welcome />);
    rerenderFn = result.rerender;
  });
  // Flush the mount-time hardware-security check (dynamic import + setState).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Simulate arriving on a new hash (router change / reload) and re-render.
async function setHash(h: string) {
  mockHash = h;
  await act(async () => {
    rerenderFn(<Welcome />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Dispatch an onboarding action through the captured onAction and await it.
async function dispatch(action: any) {
  await act(async () => {
    await mockFlowProps.current.onAction(action);
    await Promise.resolve();
  });
}

const currentStep = () => mockFlowProps.current.step;

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

beforeEach(() => {
  jest.clearAllMocks();
  mockHash = '';
  mockCanHandoff = false;
  mockFlowProps.current = null;
  mockBackHandlerRef.current = null;
  mockIsMobileFn.mockReturnValue(false);
  mockIsDesktopFn.mockReturnValue(false);
  mockDesktopHW.mockResolvedValue(false);
  mockBiometricHW.mockResolvedValue(false);
  mockRegisterWallet.mockResolvedValue(undefined);
  mockImportWalletFromClient.mockResolvedValue(undefined);
  mockPutToStorage.mockResolvedValue(undefined);
  mockSeedWalletPrompt.mockResolvedValue(undefined);
  mockFetchState.mockResolvedValue({ status: READY, accounts: [{}] });
  process.env.MIDEN_E2E_TEST = 'false';
  window.history.replaceState(null, '', '/');
  delete (globalThis as any).__TEST_SKIP_ONBOARDING;
});

afterEach(() => {
  if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
});

// ===========================================================================
// Render + mount effects
// ===========================================================================

describe('Welcome — mount & hardware-security check', () => {
  it('renders the onboarding flow on the Welcome step by default', async () => {
    await renderWelcome();
    expect(mockFlowProps.current).not.toBeNull();
    expect(currentStep()).toBe(OnboardingStep.Welcome);
    expect(mockFlowProps.current.seedPhrase).toBeNull();
    expect(mockFlowProps.current.onboardingType).toBeNull();
    // Extension/web: neither desktop nor mobile → hardware security stays false.
    expect(mockFlowProps.current.isHardwareSecurityAvailable).toBe(false);
    expect(mockDesktopHW).not.toHaveBeenCalled();
    expect(mockBiometricHW).not.toHaveBeenCalled();
  });

  it('detects desktop hardware security via secure-storage', async () => {
    mockIsDesktopFn.mockReturnValue(true);
    mockDesktopHW.mockResolvedValue(true);
    await renderWelcome();
    expect(mockDesktopHW).toHaveBeenCalled();
    expect(mockFlowProps.current.isHardwareSecurityAvailable).toBe(true);
  });

  it('detects mobile hardware security via the biometric module', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    expect(mockBiometricHW).toHaveBeenCalled();
    expect(mockFlowProps.current.isHardwareSecurityAvailable).toBe(true);
  });

  it('swallows a failing desktop hardware-security probe and reports unavailable', async () => {
    mockIsDesktopFn.mockReturnValue(true);
    mockDesktopHW.mockRejectedValue(new Error('no TPM'));
    await renderWelcome();
    expect(mockFlowProps.current.isHardwareSecurityAvailable).toBe(false);
  });

  it('falls through to unavailable when platform flips between the guard and the branch checks', async () => {
    // Passes the `!isDesktop() && !isMobile()` guard (first isDesktop() → true)
    // but then neither branch matches inside the try (second isDesktop() → false,
    // isMobile() → false), exercising the trailing `return false`.
    mockIsDesktopFn.mockReturnValueOnce(true).mockReturnValue(false);
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    expect(mockFlowProps.current.isHardwareSecurityAvailable).toBe(false);
    expect(mockDesktopHW).not.toHaveBeenCalled();
    expect(mockBiometricHW).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Hash-driven step effect
// ===========================================================================

describe('Welcome — hash → step routing', () => {
  it('routes #select-wallet-type to SelectWalletType (create)', async () => {
    await renderWelcome();
    await setHash('#select-wallet-type');
    expect(currentStep()).toBe(OnboardingStep.SelectWalletType);
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Create);
  });

  it('renders the ChooseProtection screen on mobile', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await setHash('#choose-protection');
    expect(currentStep()).toBe(OnboardingStep.ChooseProtection);
  });

  it('redirects #choose-protection to the password step where biometric cannot work', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await setHash('#choose-protection');
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
    expect(currentStep()).not.toBe(OnboardingStep.ChooseProtection);
  });

  it('renders SetupPasscode on mobile', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await setHash('#setup-passcode');
    expect(currentStep()).toBe(OnboardingStep.SetupPasscode);
  });

  it('redirects #setup-passcode to the password step off mobile', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await setHash('#setup-passcode');
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
    expect(currentStep()).not.toBe(OnboardingStep.SetupPasscode);
  });

  it('routes #setup-biometric to SetupBiometric', async () => {
    await renderWelcome();
    await setHash('#setup-biometric');
    expect(currentStep()).toBe(OnboardingStep.SetupBiometric);
  });

  it('routes #choose-guardian to ChooseGuardian', async () => {
    await renderWelcome();
    await setHash('#choose-guardian');
    expect(currentStep()).toBe(OnboardingStep.ChooseGuardian);
  });

  it('routes #select-import-type to SelectImportType (import)', async () => {
    await renderWelcome();
    await setHash('#select-import-type');
    expect(currentStep()).toBe(OnboardingStep.SelectImportType);
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Import);
  });

  it('routes #import-from-seed and #import-from-file', async () => {
    await renderWelcome();
    await setHash('#import-from-seed');
    expect(currentStep()).toBe(OnboardingStep.ImportFromSeed);
    await setHash('#import-from-file');
    expect(currentStep()).toBe(OnboardingStep.ImportFromFile);
  });

  it('redirects #create-password back to Welcome when onboarding state was lost', async () => {
    await renderWelcome();
    await setHash('#create-password');
    // onboardingType is null on a fresh reload → bounce to '/'.
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(currentStep()).not.toBe(OnboardingStep.CreatePassword);
  });

  it('renders CreatePassword when onboarding state is present', async () => {
    await renderWelcome();
    // Establish onboardingType via an action first.
    await dispatch({ id: 'select-import-type' });
    await setHash('#create-password');
    expect(currentStep()).toBe(OnboardingStep.CreatePassword);
  });

  it('routes #import-select-recovery-method', async () => {
    await renderWelcome();
    await setHash('#import-select-recovery-method');
    expect(currentStep()).toBe(OnboardingStep.ImportSelectRecoveryMethod);
  });

  it('redirects #confirmation to Welcome when no password has been set', async () => {
    await renderWelcome();
    await setHash('#confirmation');
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(currentStep()).not.toBe(OnboardingStep.Confirmation);
  });

  it('renders Confirmation once a password exists', async () => {
    await renderWelcome();
    // setup-passcode-submit commits a password.
    await dispatch({ id: 'setup-passcode-submit', payload: '123456' });
    await setHash('#confirmation');
    expect(currentStep()).toBe(OnboardingStep.Confirmation);
  });

  it('ignores unknown hashes (default branch) and returns to Welcome on empty hash', async () => {
    await renderWelcome();
    await setHash('#select-wallet-type');
    expect(currentStep()).toBe(OnboardingStep.SelectWalletType);
    await setHash('#not-a-real-route');
    // default branch: step unchanged.
    expect(currentStep()).toBe(OnboardingStep.SelectWalletType);
    await setHash('');
    expect(currentStep()).toBe(OnboardingStep.Welcome);
  });
});

// ===========================================================================
// onAction — forward navigation branches
// ===========================================================================

describe('Welcome — onAction forward navigation', () => {
  it('choose-protection routes to the protection step and tracks the event', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' });
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Create);
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-protection');
    expect(mockTrackEvent).toHaveBeenCalledWith('choose-protection', 'button-press', {});
  });

  it('choose-protection off mobile skips straight to create-password', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' });
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });

  it('setup-passcode and setup-biometric navigate to their screens', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode' });
    expect(mockNavigate).toHaveBeenCalledWith('/#setup-passcode');
    await dispatch({ id: 'setup-biometric' });
    expect(mockNavigate).toHaveBeenCalledWith('/#setup-biometric');
  });

  it('setup-biometric-submit generates a seed and routes to guardian selection', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    expect(mockFlowProps.current.seedPhrase).toEqual('aa bb cc dd ee ff gg hh ii jj kk ll'.split(' '));
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Create);
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-guardian');
  });

  it('setup-passcode-submit commits the passcode as the password', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '654321' });
    expect(mockFlowProps.current.password).toBe('654321');
    expect(mockFlowProps.current.seedPhrase).not.toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-guardian');
  });

  it('select-import-type / import-from-file / import-from-seed navigate correctly', async () => {
    await renderWelcome();
    await dispatch({ id: 'select-import-type' });
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Import);
    expect(mockNavigate).toHaveBeenCalledWith('/#select-import-type');
    await dispatch({ id: 'import-from-file' });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-from-file');
    await dispatch({ id: 'import-from-seed' });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-from-seed');
  });

  it('ignores unrecognised action ids (default) but still tracks', async () => {
    await renderWelcome();
    await dispatch({ id: 'totally-unknown' });
    expect(mockTrackEvent).toHaveBeenCalledWith('totally-unknown', 'button-press', {});
  });
});

// ===========================================================================
// choose-guardian-submit branches
// ===========================================================================

describe('Welcome — choose-guardian-submit', () => {
  it('goes straight to confirmation when a passcode password already exists', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '111111' });
    mockNavigate.mockClear();
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    expect(mockPutToStorage).toHaveBeenCalledWith('guardian_url_setting', 'https://g');
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });

  it('uses hardware-only protection when biometric hardware is available', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' }); // seed, no password
    mockNavigate.mockClear();
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    expect(mockFlowProps.current.password).toBe('__HARDWARE_ONLY__');
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });

  it('falls back to the password screen when no hardware security is available', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(false);
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    mockNavigate.mockClear();
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    expect(mockFlowProps.current.password).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });
});

// ===========================================================================
// import-*-submit branches
// ===========================================================================

describe('Welcome — import submits', () => {
  it('import-wallet-file-submit skips the password step under hardware security', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({
      id: 'import-wallet-file-submit',
      payload: 'aa bb cc',
      walletAccounts: [{ id: 'acc1' }]
    });
    expect(mockFlowProps.current.seedPhrase).toEqual(['aa', 'bb', 'cc']);
    expect(mockFlowProps.current.password).toBe('__HARDWARE_ONLY__');
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });

  it('import-wallet-file-submit shows the password screen without hardware security', async () => {
    await renderWelcome();
    await dispatch({
      id: 'import-wallet-file-submit',
      payload: 'aa bb cc',
      walletAccounts: []
    });
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });

  it('import-seed-phrase-submit skips password to recovery-method under hardware security', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' });
    expect(mockFlowProps.current.seedPhrase).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(mockFlowProps.current.password).toBe('__HARDWARE_ONLY__');
    expect(mockNavigate).toHaveBeenCalledWith('/#import-select-recovery-method');
  });

  it('import-seed-phrase-submit shows the password screen without hardware security', async () => {
    await renderWelcome();
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' });
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });
});

// ===========================================================================
// create-password-submit branches
// ===========================================================================

describe('Welcome — create-password-submit', () => {
  it('create flow off mobile generates a seed and heads to guardian selection', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // onboardingType = Create
    mockNavigate.mockClear();
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    expect(mockFlowProps.current.password).toBe('pw');
    expect(mockFlowProps.current.seedPhrase).not.toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-guardian');
    expect(mockTrackEvent).toHaveBeenLastCalledWith('create-password-submit', 'form-submit', {});
  });

  it('seed-phrase import routes to recovery-method selection', async () => {
    await renderWelcome();
    await dispatch({ id: 'select-import-type' }); // onboardingType = Import
    await dispatch({ id: 'import-from-seed' }); // importType = SeedPhrase
    mockNavigate.mockClear();
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-select-recovery-method');
  });

  it('otherwise proceeds directly to confirmation (mobile create path)', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // onboardingType = Create (mobile)
    mockNavigate.mockClear();
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });
});

// ===========================================================================
// import-select-recovery-method branches
// ===========================================================================

describe('Welcome — import-select-recovery-method', () => {
  it('persists the guardian endpoint for guardian wallets', async () => {
    await renderWelcome();
    await dispatch({
      id: 'import-select-recovery-method',
      payload: { walletType: WalletType.Guardian, guardianEndpoint: 'https://g' }
    });
    expect(mockPutToStorage).toHaveBeenCalledWith('guardian_url_setting', 'https://g');
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });

  it('skips storage for non-guardian wallets', async () => {
    await renderWelcome();
    await dispatch({
      id: 'import-select-recovery-method',
      payload: { walletType: WalletType.OffChain }
    });
    expect(mockPutToStorage).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });
});

// ===========================================================================
// register() via the confirmation action
// ===========================================================================

describe('Welcome — confirmation / register', () => {
  it('creates the wallet, waits for Ready, then enters the wallet home', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '123456' }); // seed + password (Create)
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });

    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.Guardian, '123456', expect.any(String), false);
    // Create flow triggers the verify-seed prompt.
    expect(mockSeedWalletPrompt).toHaveBeenCalledWith('verify-seed-phrase');
    expect(mockSyncFromBackend).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(mockFlowProps.current.isLoading).toBe(false);
    expect(mockTrackEvent).toHaveBeenLastCalledWith('confirmation', 'form-submit', {});
  });

  it('imports from a wallet file instead of registering when flagged', async () => {
    await renderWelcome();
    // import-wallet-file-submit (no hardware) → create-password screen.
    await dispatch({ id: 'import-wallet-file-submit', payload: 'aa bb cc', walletAccounts: [{ id: 'a' }] });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockImportWalletFromClient).toHaveBeenCalledWith('pw', expect.any(String), [{ id: 'a' }]);
    expect(mockRegisterWallet).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('swallows an import-from-client error and still navigates home', async () => {
    mockImportWalletFromClient.mockRejectedValue(new Error('bad file'));
    await renderWelcome();
    await dispatch({ id: 'import-wallet-file-submit', payload: 'aa bb cc', walletAccounts: [] });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockImportWalletFromClient).toHaveBeenCalled();
    // register() caught the error internally → confirmation still succeeds.
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('passes undefined password through for hardware-only wallets', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.Guardian, undefined, expect.any(String), false);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('surfaces a guardian lookup failure on the recovery-method screen (import)', async () => {
    mockRegisterWallet.mockRejectedValue(new Error('guardian not found'));
    await renderWelcome();
    await dispatch({ id: 'select-import-type' }); // onboardingType = Import
    await dispatch({ id: 'import-from-seed' }); // importType = SeedPhrase
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({
      id: 'import-select-recovery-method',
      payload: { walletType: WalletType.Guardian, guardianEndpoint: 'https://g' }
    });
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockFlowProps.current.guardianLookupError).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/#import-select-recovery-method');
    expect(mockFlowProps.current.isLoading).toBe(false);
  });

  it('records a biometric error when hardware-only registration fails', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    mockRegisterWallet.mockRejectedValue(new Error('face not recognised'));
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockFlowProps.current.biometricAttempts).toBe(1);
    expect(mockFlowProps.current.biometricError).toBe('face not recognised');
  });

  it('records a generic biometric error message for non-Error throws', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    mockRegisterWallet.mockRejectedValue('nope');
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    await dispatch({ id: 'confirmation' });
    expect(mockFlowProps.current.biometricError).toBe('Biometric authentication failed');
  });

  it('throws inside register when the seed phrase is missing (neither catch branch)', async () => {
    // Mobile create flow commits a password but no seed (passcode never ran),
    // so register() throws "Missing password or seed phrase" and the catch
    // falls through both the guardian and hardware-only branches.
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // onboardingType = Create
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } }); // mobile → confirmation, no seed
    mockNavigate.mockClear();
    await dispatch({ id: 'confirmation' });
    expect(mockRegisterWallet).not.toHaveBeenCalled();
    expect(mockFlowProps.current.isLoading).toBe(false);
    expect(mockFlowProps.current.guardianLookupError).toBe(false);
    // navigation home never happened because register threw.
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });
});

// ===========================================================================
// waitForReadyState retry + max-attempts (via confirmation) — fake timers
// ===========================================================================

describe('Welcome — waitForReadyState resilience', () => {
  it('retries after a failed state fetch before Ready arrives', async () => {
    jest.useFakeTimers();
    try {
      mockFetchState.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: READY, accounts: [{}] });
      await renderWelcome();
      await dispatch({ id: 'setup-passcode-submit', payload: '123456' });
      mockNavigate.mockClear();

      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = mockFlowProps.current.onAction({ id: 'confirmation' });
      });
      // Drive the 100ms backoff between the rejected fetch and the Ready fetch.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(200);
      });
      await act(async () => {
        await pending;
      });

      expect(mockFetchState).toHaveBeenCalledTimes(2);
      expect(mockNavigate).toHaveBeenCalledWith('/');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after the maximum number of attempts and still navigates home', async () => {
    jest.useFakeTimers();
    try {
      // Never reaches Ready; also omits `accounts` to exercise the optional chain.
      mockFetchState.mockResolvedValue({ status: IDLE });
      await renderWelcome();
      await dispatch({ id: 'setup-passcode-submit', payload: '123456' });
      mockNavigate.mockClear();

      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = mockFlowProps.current.onAction({ id: 'confirmation' });
      });
      // 10 attempts × 100ms backoff.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100 * 12);
      });
      await act(async () => {
        await pending;
      });

      expect(mockFetchState.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(mockNavigate).toHaveBeenCalledWith('/');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ===========================================================================
// switch-to-password
// ===========================================================================

describe('Welcome — switch-to-password', () => {
  it('clears biometric state and heads to the password screen', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    mockRegisterWallet.mockRejectedValue(new Error('boom'));
    await renderWelcome();
    // Build up a biometric attempt count / error first.
    await dispatch({ id: 'setup-biometric-submit' });
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } });
    await dispatch({ id: 'confirmation' });
    expect(mockFlowProps.current.biometricAttempts).toBe(1);

    mockNavigate.mockClear();
    await dispatch({ id: 'switch-to-password' });
    expect(mockFlowProps.current.useBiometric).toBe(false);
    expect(mockFlowProps.current.password).toBeNull();
    expect(mockFlowProps.current.biometricAttempts).toBe(0);
    expect(mockFlowProps.current.biometricError).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });
});

// ===========================================================================
// back navigation — every step branch
// ===========================================================================

describe('Welcome — back navigation', () => {
  it('returns to Welcome from the top-level selection screens', async () => {
    await renderWelcome();
    await setHash('#select-import-type');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('returns to Welcome from ChooseProtection', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await setHash('#choose-protection');
    expect(currentStep()).toBe(OnboardingStep.ChooseProtection);
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('SetupBiometric back returns to ChooseProtection on mobile', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await setHash('#setup-biometric');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-protection');
  });

  it('SetupBiometric back returns to Welcome where biometric is unsupported', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await setHash('#setup-biometric');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('ChooseGuardian back follows the biometric protection method', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' }); // protectionMethod = biometric
    await setHash('#choose-guardian');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#setup-biometric');
  });

  it('ChooseGuardian back follows the password protection method', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // Create
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } }); // protectionMethod = password
    await setHash('#choose-guardian');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });

  it('ChooseGuardian back defaults to the passcode screen', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '111111' }); // protectionMethod = passcode
    await setHash('#choose-guardian');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#setup-passcode');
  });

  it('CreatePassword back returns to guardian selection during a mobile create', async () => {
    mockIsMobileFn.mockReturnValue(true);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // onboardingType = Create
    await setHash('#create-password');
    expect(currentStep()).toBe(OnboardingStep.CreatePassword);
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#choose-guardian');
  });

  it('CreatePassword back returns to Welcome during a desktop create', async () => {
    mockIsMobileFn.mockReturnValue(false);
    await renderWelcome();
    await dispatch({ id: 'choose-protection' }); // onboardingType = Create
    await setHash('#create-password');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('CreatePassword back returns to the file import for a file import', async () => {
    await renderWelcome();
    await dispatch({ id: 'select-import-type' }); // Import
    await dispatch({ id: 'import-from-file' }); // importType = WalletFile
    await setHash('#create-password');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-from-file');
  });

  it('CreatePassword back returns to the seed import for a seed import', async () => {
    await renderWelcome();
    await dispatch({ id: 'select-import-type' }); // Import
    await dispatch({ id: 'import-from-seed' }); // importType = SeedPhrase
    await setHash('#create-password');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-from-seed');
  });

  it('ImportSelectRecoveryMethod back returns to seed import under hardware-only', async () => {
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' }); // password = HARDWARE_ONLY
    await setHash('#import-select-recovery-method');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#import-from-seed');
  });

  it('ImportSelectRecoveryMethod back returns to the password screen otherwise', async () => {
    await renderWelcome();
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' }); // no hardware → normal password
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await setHash('#import-select-recovery-method');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#create-password');
  });

  it('ImportFromFile / ImportFromSeed back to the import-type chooser', async () => {
    await renderWelcome();
    await setHash('#import-from-file');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#select-import-type');

    await setHash('#import-from-seed');
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).toHaveBeenCalledWith('/#select-import-type');
  });

  it('does nothing for back on the Welcome step', async () => {
    await renderWelcome();
    mockNavigate.mockClear();
    await dispatch({ id: 'back' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Side-panel handoff auto-create effect
// ===========================================================================

describe('Welcome — side-panel handoff', () => {
  it('auto-creates the wallet and moves to the handoff route on Confirmation', async () => {
    mockCanHandoff = true;
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '123456' }); // Create, password + seed
    mockNavigate.mockClear();
    await setHash('#confirmation');
    // The effect fires on arrival; flush its async register.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegisterWallet).toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('confirmation', 'form-submit', {});
    expect(mockNavigate).toHaveBeenCalledWith('/finish-side-panel');
    expect(mockFlowProps.current.confirmCreating).toBe(true);
  });

  it('falls back to the classic flow when the auto-create fails', async () => {
    mockCanHandoff = true;
    mockRegisterWallet.mockRejectedValue(new Error('creation failed'));
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '123456' });
    mockNavigate.mockClear();
    await setHash('#confirmation');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegisterWallet).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('/finish-side-panel');
    // confirmPhase reverted to 'failed' → confirmCreating is false again.
    expect(mockFlowProps.current.confirmCreating).toBe(false);
  });

  it('does not auto-create hardware-only wallets (deferred to a tap)', async () => {
    mockCanHandoff = true;
    mockIsMobileFn.mockReturnValue(true);
    mockBiometricHW.mockResolvedValue(true);
    await renderWelcome();
    await dispatch({ id: 'setup-biometric-submit' });
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianEndpoint: 'https://g' } }); // HARDWARE_ONLY
    mockNavigate.mockClear();
    mockRegisterWallet.mockClear();
    await setHash('#confirmation');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegisterWallet).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('/finish-side-panel');
  });

  it('does not auto-create for import flows', async () => {
    mockCanHandoff = true;
    await renderWelcome();
    // Build an import flow that lands on confirmation with a password + seed.
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'aa bb cc dd' }); // Import
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({
      id: 'import-select-recovery-method',
      payload: { walletType: WalletType.OffChain }
    });
    mockNavigate.mockClear();
    mockRegisterWallet.mockClear();
    await setHash('#confirmation');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRegisterWallet).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('/finish-side-panel');
  });
});

// ===========================================================================
// Mobile back-button handler
// ===========================================================================

describe('Welcome — mobile back handler', () => {
  it('lets the system handle back on the Welcome step', async () => {
    await renderWelcome();
    expect(mockBackHandlerRef.current).not.toBeNull();
    let result: boolean | void;
    await act(async () => {
      result = mockBackHandlerRef.current!();
    });
    expect(result).toBe(false);
  });

  it('triggers the onboarding back action on other steps', async () => {
    await renderWelcome();
    await setHash('#select-import-type');
    mockNavigate.mockClear();
    let result: boolean | void;
    await act(async () => {
      result = mockBackHandlerRef.current!();
    });
    expect(result).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('consumes back without navigating while the confirmation is loading', async () => {
    // register() never resolves → isLoading stays true on the Confirmation step.
    mockRegisterWallet.mockImplementation(() => new Promise(() => {}));
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '123456' });
    await setHash('#confirmation');
    expect(currentStep()).toBe(OnboardingStep.Confirmation);

    // Kick off confirmation; it commits isLoading = true then hangs on register.
    await act(async () => {
      mockFlowProps.current.onAction({ id: 'confirmation' });
    });
    expect(mockFlowProps.current.isLoading).toBe(true);

    mockNavigate.mockClear();
    let result: boolean | void;
    await act(async () => {
      result = mockBackHandlerRef.current!();
    });
    expect(result).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// E2E test-bypass effects
// ===========================================================================

describe('Welcome — E2E onboarding bypass', () => {
  it('does nothing when the E2E build flag is off', async () => {
    process.env.MIDEN_E2E_TEST = 'false';
    (globalThis as any).__TEST_SKIP_ONBOARDING = true;
    await renderWelcome();
    expect(mockFlowProps.current.password).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalledWith('/#confirmation');
  });

  it('does nothing under the E2E flag without a skip trigger', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    await renderWelcome();
    expect(mockFlowProps.current.password).toBeNull();
  });

  it('imports an explicit guardian seed via URL params', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    window.history.replaceState(
      null,
      '',
      '/?__test_skip_onboarding=1&walletType=guardian&seed=alpha+beta+gamma&password=pw'
    );
    await renderWelcome();
    expect(mockFlowProps.current.seedPhrase).toEqual(['alpha', 'beta', 'gamma']);
    expect(mockFlowProps.current.password).toBe('pw');
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Import);
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });

  it('creates a fresh off-chain wallet via the CDP global', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as any).__TEST_SKIP_ONBOARDING = true;
    await renderWelcome();
    expect(mockFlowProps.current.password).toBe('password1');
    expect(mockFlowProps.current.onboardingType).toBe(OnboardingType.Create);
    expect(mockFlowProps.current.seedPhrase).not.toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/#confirmation');
  });
});
