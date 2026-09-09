import React from 'react';

import { act, render } from '@testing-library/react';

import { deserializeError } from 'lib/intercom/helpers';
import { OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

import ForgotPassword from './ForgotPassword';

// ---------------------------------------------------------------------------
// Mutable state the mocks read/write at call time (must be `mock`-prefixed so
// jest allows referencing them inside hoisted `jest.mock` factories).
// ---------------------------------------------------------------------------
const mockRegisterWallet = jest.fn<Promise<void>, unknown[]>();
const mockClearClientStorage = jest.fn();
const mockNavigate = jest.fn();
const mockGenerateMnemonic = jest.fn(() => 'a b c d e f g h i j k l');

// Captures the props handed to the (mocked) OnboardingFlow on every render, plus
// the latest mobile-back-handler closure registered by the component.
const captured: {
  onAction?: (action: { id: string; [k: string]: unknown }) => void | Promise<void>;
  backHandler?: () => boolean | void;
  props?: Record<string, unknown>;
} = {};

// ---------------------------------------------------------------------------
// Module mocks — replace every heavy / native dependency with a light stub so
// the page renders in jsdom without pulling in wasm, bip39, woozie or the real
// onboarding navigator.
// ---------------------------------------------------------------------------
jest.mock('screens/onboarding/navigator', () => ({
  OnboardingFlow: (props: Record<string, unknown>) => {
    captured.onAction = props.onAction as typeof captured.onAction;
    captured.props = props;
    const seedPhrase = props.seedPhrase as string[] | null;
    return (
      <div
        data-testid="onboarding-flow"
        data-step={String(props.step)}
        data-type={String(props.onboardingType)}
        data-loading={String(props.isLoading)}
        data-seed={seedPhrase ? seedPhrase.join(',') : ''}
        data-wordslist={Array.isArray(props.wordslist) ? (props.wordslist as string[]).join(',') : ''}
      />
    );
  }
}));

const mockScanForAccounts = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    registerWallet: mockRegisterWallet,
    scanForAccounts: (...args: unknown[]) => mockScanForAccounts(...args)
  })
}));

// Accounts list the recovered-accounts overview renders (store re-syncs after every scan).
const mockStoreAccounts = [{ publicKey: 'mtst1recovered' }];
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: { accounts: unknown[] }) => unknown) => selector({ accounts: mockStoreAccounts })
}));

jest.mock('lib/miden/reset', () => ({
  clearClientStorage: () => mockClearClientStorage()
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

const mockPostOnboardingRoute = jest.fn<string, []>(() => '/');
jest.mock('lib/extension/side-panel-handoff', () => ({
  postOnboardingRoute: () => mockPostOnboardingRoute()
}));

// Store the latest handler closure so tests can invoke the mobile back handler
// directly with the component's current `step` / `isLoading` captured in scope.
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    captured.backHandler = handler;
  }
}));

// `formatMnemonic` is exercised in its own suite; here we just need a passthrough
// so we can assert the joined seed phrase flows through to register/import.
jest.mock('app/defaults', () => ({
  formatMnemonic: (m: string) => `fmt:${m}`
}));

jest.mock('bip39', () => ({
  generateMnemonic: (...args: unknown[]) => mockGenerateMnemonic(...(args as [])),
  __esModule: true
}));

jest.mock('bip39/src/wordlists/english.json', () => ['abandon', 'ability', 'able']);

// Guardian auto-detection: the real hook dynamically imports the WASM SDK.
// Stub it with a controllable start() so tests can steer what the probe found.
const mockProbeStart = jest.fn<Promise<unknown>, unknown[]>();
const mockProbeReset = jest.fn();
jest.mock('lib/miden/guardian/use-guardian-probe', () => ({
  GUARDIAN_PROBE_WAIT_DEADLINE_MS: 50,
  useGuardianProbe: () => ({ state: { status: 'idle' }, start: mockProbeStart, reset: mockProbeReset })
}));

const mockPutToStorage = jest.fn<Promise<void>, unknown[]>();
const mockFetchFromStorage = jest.fn<Promise<unknown>, unknown[]>(async () => null);
jest.mock('lib/miden/front/storage', () => ({
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args),
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

// The key `Vault.spawn`'s reset preserves; the page has to preserve it across
// its own wipe too (see the endpoint-override test below).
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ENDPOINT_OVERRIDE_STORAGE_KEY: 'endpoint_overrides'
}));

const PROBED_RESULT = {
  best: {
    endpoint: 'https://probed.example.com',
    accountIds: ['acct-1'],
    hdIndices: [0],
    nonce: 5n
  },
  matches: [],
  probedEndpoints: ['https://probed.example.com'],
  failures: []
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Action = { id: string; [k: string]: unknown };

async function dispatch(action: Action) {
  await act(async () => {
    await captured.onAction!(action);
  });
}

function flow(container: HTMLElement) {
  return container.querySelector('[data-testid="onboarding-flow"]')!;
}

function renderPage() {
  const utils = render(<ForgotPassword />);
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchFromStorage.mockResolvedValue(null);
  mockRegisterWallet.mockResolvedValue(undefined);
  mockPostOnboardingRoute.mockReturnValue('/');
  mockGenerateMnemonic.mockReturnValue('a b c d e f g h i j k l');
  captured.onAction = undefined;
  captured.backHandler = undefined;
  captured.props = undefined;
});

describe('ForgotPassword', () => {
  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------
  it('renders OnboardingFlow at the Welcome step with default props', () => {
    const { container } = renderPage();
    const el = flow(container);
    expect(el.getAttribute('data-step')).toBe(OnboardingStep.Welcome);
    expect(el.getAttribute('data-type')).toBe('null');
    expect(el.getAttribute('data-loading')).toBe('false');
    expect(el.getAttribute('data-seed')).toBe('');
    // wordslist mock flows straight through from the JSON import.
    expect(el.getAttribute('data-wordslist')).toBe('abandon,ability,able');
  });

  // -------------------------------------------------------------------------
  // onAction — non-back navigation branches
  // -------------------------------------------------------------------------
  it('create-wallet: generates a seed phrase and moves to BackupSeedPhrase (Create)', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'create-wallet' });
    const el = flow(container);
    expect(mockGenerateMnemonic).toHaveBeenCalledWith(128);
    expect(el.getAttribute('data-seed')).toBe('a,b,c,d,e,f,g,h,i,j,k,l');
    expect(el.getAttribute('data-type')).toBe(OnboardingType.Create);
    expect(el.getAttribute('data-step')).toBe(OnboardingStep.BackupSeedPhrase);
  });

  it('select-import-type: sets Import type and jumps straight to ImportFromSeed', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'select-import-type' });
    const el = flow(container);
    expect(el.getAttribute('data-type')).toBe(OnboardingType.Import);
    expect(el.getAttribute('data-step')).toBe(OnboardingStep.ImportFromSeed);
  });

  it('import-from-seed: moves to ImportFromSeed step', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'import-from-seed' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.ImportFromSeed);
  });

  it('import-seed-phrase-submit: splits payload into seed and moves to CreatePassword', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'one two three' });
    const el = flow(container);
    expect(el.getAttribute('data-seed')).toBe('one,two,three');
    expect(el.getAttribute('data-step')).toBe(OnboardingStep.CreatePassword);
  });

  it('backup-seed-phrase: regenerates seed and shows BackupSeedPhrase step', async () => {
    mockGenerateMnemonic.mockReturnValue('m n o p q r s t u v w x');
    const { container } = renderPage();
    await dispatch({ id: 'backup-seed-phrase' });
    const el = flow(container);
    expect(el.getAttribute('data-seed')).toBe('m,n,o,p,q,r,s,t,u,v,w,x');
    expect(el.getAttribute('data-step')).toBe(OnboardingStep.BackupSeedPhrase);
  });

  it('verify-seed-phrase: moves to VerifySeedPhrase step', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'verify-seed-phrase' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.VerifySeedPhrase);
  });

  it('create-password: moves to CreatePassword step', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'create-password' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.CreatePassword);
  });

  it('create-password-submit: stores the password and moves to Confirmation', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Confirmation);
  });

  it('unknown action id: default branch is a no-op', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'totally-unknown' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Welcome);
  });

  // -------------------------------------------------------------------------
  // confirmation → register()
  // -------------------------------------------------------------------------
  it('confirmation without a password: skips register (password falsy) but still navigates home', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'confirmation' });
    expect(mockClearClientStorage).not.toHaveBeenCalled();
    expect(mockRegisterWallet).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
    // loading toggled back off after the flow completes.
    expect(flow(container).getAttribute('data-loading')).toBe('false');
  });

  it('confirmation (Create flow): registers a Guardian wallet with ownMnemonic=false', async () => {
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockClearClientStorage).toHaveBeenCalledTimes(1);
    // Create flow: no probe runs, so no endpoint is threaded (undefined 5th arg).
    expect(mockRegisterWallet).toHaveBeenCalledWith(
      WalletType.Guardian,
      'secret',
      'fmt:a b c d e f g h i j k l',
      false,
      undefined
    );
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  /**
   * The recovery wipe must not take the dev-settings endpoint override with it.
   * `clearClientStorage()` is a blanket `localStorage.clear()`, and on desktop
   * localStorage IS the platform key-value store, so the override — the one key
   * a storage reset is supposed to survive — went with it. `Vault.spawn`'s reset
   * snapshots it only AFTER this call, so it read null and restored nothing: the
   * account was recovered on the custom network while the next launch resolved
   * the build-default endpoints (empty balances, wrong native token, no error).
   */
  it('preserves the endpoint override across the recovery wipe (desktop localStorage)', async () => {
    mockFetchFromStorage.mockResolvedValue({ rpcUrl: 'https://custom.example.com' });
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockFetchFromStorage).toHaveBeenCalledWith('endpoint_overrides');
    expect(mockPutToStorage).toHaveBeenCalledWith('endpoint_overrides', { rpcUrl: 'https://custom.example.com' });
    // Read BEFORE the wipe, written back AFTER it — the order is the fix.
    expect(mockFetchFromStorage.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearClientStorage.mock.invocationCallOrder[0]!
    );
    expect(mockPutToStorage.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockClearClientStorage.mock.invocationCallOrder[0]!
    );
  });

  it('writes no override back when none was set', async () => {
    // The common case: no dev-settings override, so the wipe has nothing to
    // preserve and must not resurrect a key with a null value.
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockClearClientStorage).toHaveBeenCalledTimes(1);
    expect(mockPutToStorage).not.toHaveBeenCalled();
  });

  it('confirmation hands off to the side panel when available (#428)', async () => {
    mockPostOnboardingRoute.mockReturnValue('/finish-side-panel');
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockRegisterWallet).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/finish-side-panel');
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });

  it('confirmation does NOT navigate when registration fails — the reset already happened (#630)', async () => {
    // clearClientStorage() runs BEFORE registerWallet, so a rejection here leaves
    // the user with no local wallet. Navigating away would drop them on a wiped
    // wallet with no explanation, which is indistinguishable from data loss. Stay
    // on the confirmation step so the surfaced error and Retry are reachable.
    mockPostOnboardingRoute.mockReturnValue('/finish-side-panel');
    mockRegisterWallet.mockRejectedValue(new Error('guardian not found'));
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirmation surfaces the registration failure reason to the user (#630)', async () => {
    // The reason was previously console.error'd only. It must reach the screen —
    // "something went wrong" with no detail is not actionable after a wipe.
    mockRegisterWallet.mockRejectedValue(new Error('guardian not found'));
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    // OnboardingFlow is mocked here, so assert the reason is handed DOWN; that it
    // is then rendered is covered by Confirmation.test.tsx.
    expect(captured.props?.recoveryError).toContain('guardian not found');
  });

  it('surfaces the reason for the shape the EXTENSION actually rejects with (#630)', async () => {
    // Every other case here rejects with `new Error(...)`, which is not what
    // production produces: on the extension `registerWallet` crosses the intercom
    // port and a rejected request rejects with `deserializeError(...)`. That used
    // to be an object that only `implements Error`, so the `e instanceof Error`
    // narrowing below fell through to `String(e)` and the user — whose wallet had
    // just been wiped — was shown the literal "[object Object]". Build the error
    // through the real deserializer so this stays pinned to the production shape.
    mockRegisterWallet.mockRejectedValue(deserializeError('Failed to create wallet'));
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    // Before the fix this was the literal string "[object Object]".
    expect(captured.props?.recoveryError).toBe('Failed to create wallet');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('confirmation (Import-from-seed flow): registers with ownMnemonic=true (Import ternary)', async () => {
    renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-from-seed' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw2' } });
    await dispatch({ id: 'confirmation' });

    // The recovery-method step was never submitted, so no endpoint is threaded
    // (the backend then runs its best-effort guardian scan against the stored /
    // default endpoint) and the fresh-wallet fallback type stays Guardian.
    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.Guardian, 'pw2', 'fmt:seed words here', true, undefined);
  });

  it('Import flow: the password step leads to the recovery-method step, not straight to Confirmation', async () => {
    // Without this step the flow could only ever recover the Guardian BIP-44
    // namespace, so a user who onboarded with "no guardian" had their wallet
    // wiped by clearClientStorage() and then hit "No Guardian accounts found at
    // this guardian endpoint for this seed" — their OffChain account at
    // m/44'/0'/1'/0' was never derived or looked up.
    const { container } = renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });

    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.ImportSelectRecoveryMethod);
  });

  it('Import flow: skipping the guardian step threads NO endpoint and falls back to a public wallet type', async () => {
    mockProbeStart.mockResolvedValue(PROBED_RESULT);

    renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({ id: 'import-select-recovery-method', payload: {} });
    await dispatch({ id: 'confirmation' });

    // "Skip" is an explicit "I have no guardian": the background probe's winner
    // must NOT be silently adopted, and a zero-found restore creates a public
    // wallet rather than a guardian-backed one.
    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.OnChain, 'pw', 'fmt:seed words here', true, undefined);
  });

  it('Import flow: a guardian recovery uses the endpoint chosen on the recovery-method step', async () => {
    mockProbeStart.mockResolvedValue(PROBED_RESULT);

    renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({
      id: 'import-select-recovery-method',
      payload: { guardianEndpoint: 'https://chosen.example.com' }
    });
    await dispatch({ id: 'confirmation' });

    // The user's explicit pick wins over the background probe's winner.
    expect(mockRegisterWallet).toHaveBeenCalledWith(
      WalletType.Guardian,
      'pw',
      'fmt:seed words here',
      true,
      'https://chosen.example.com'
    );
  });

  it('Create (reset) flow: still goes straight to Confirmation — a fresh seed has nothing to look up', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });

    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Confirmation);
  });

  it('confirmation (Import flow): the probe only prefills the recovery-method step, never registerWallet', async () => {
    mockProbeStart.mockResolvedValue(PROBED_RESULT);

    renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({ id: 'confirmation' });

    expect(mockProbeStart).toHaveBeenCalledWith(['seed', 'words', 'here']);
    // Stage 1 of #408: nothing is written to the global GUARDIAN_URL_STORAGE_KEY.
    expect(mockPutToStorage).not.toHaveBeenCalled();
    // The submitted recovery-method payload is the single source of truth: with
    // no submission there is no silent probe-result fallback.
    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.Guardian, 'pw', 'fmt:seed words here', true, undefined);

    // clearClientStorage still runs before registerWallet.
    const clearedAt = mockClearClientStorage.mock.invocationCallOrder[0]!;
    const registeredAt = mockRegisterWallet.mock.invocationCallOrder[0]!;
    expect(clearedAt).toBeLessThan(registeredAt);
  });

  // -------------------------------------------------------------------------
  // Recovered-accounts overview (post-registration import step)
  // -------------------------------------------------------------------------
  async function importToConfirmation(endpoint?: string) {
    const utils = renderPage();
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'pw' } });
    await dispatch({ id: 'import-select-recovery-method', payload: { guardianEndpoint: endpoint } });
    return utils;
  }

  it('Import flow: a successful restore pauses on the recovered-accounts overview instead of entering', async () => {
    const { container } = await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.RecoveredAccounts);
    expect(captured.props?.recoveredAccounts).toBe(mockStoreAccounts);
    expect(captured.props?.isScanning).toBe(false);
    expect(captured.props?.scanError).toBeNull();
    expect(captured.props?.lastScanFoundNone).toBe(false);
  });

  it('Create (reset) flow: a successful registration still enters the wallet directly', async () => {
    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('scan-more-accounts forwards the count and chosen endpoint and reports a found-none scan', async () => {
    mockScanForAccounts.mockResolvedValue([]);
    await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });

    await dispatch({ id: 'scan-more-accounts', payload: { count: 5 } });
    expect(mockScanForAccounts).toHaveBeenCalledWith(5, 'https://chosen.example.com');
    expect(captured.props?.lastScanFoundNone).toBe(true);
    expect(captured.props?.isScanning).toBe(false);
    expect(captured.props?.scanError).toBeNull();
  });

  it('scan-more-accounts clears the found-none flag once accounts turn up', async () => {
    mockScanForAccounts.mockResolvedValueOnce([]).mockResolvedValueOnce([{ publicKey: 'mtst1new' }]);
    await importToConfirmation();
    await dispatch({ id: 'confirmation' });

    await dispatch({ id: 'scan-more-accounts', payload: { count: 5 } });
    expect(captured.props?.lastScanFoundNone).toBe(true);
    await dispatch({ id: 'scan-more-accounts', payload: { count: 5 } });
    expect(mockScanForAccounts).toHaveBeenLastCalledWith(5, undefined);
    expect(captured.props?.lastScanFoundNone).toBe(false);
  });

  it('scan-more-accounts surfaces an Error message and a stringified non-Error', async () => {
    mockScanForAccounts.mockRejectedValueOnce(new Error('node unreachable')).mockRejectedValueOnce('nope');
    await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });

    await dispatch({ id: 'scan-more-accounts', payload: { count: 5 } });
    expect(captured.props?.scanError).toBe('node unreachable');
    expect(captured.props?.isScanning).toBe(false);

    await dispatch({ id: 'scan-more-accounts', payload: { count: 5 } });
    expect(captured.props?.scanError).toBe('nope');
  });

  it('marks the overview as scanning while a scan is pending', async () => {
    let release!: (found: unknown[]) => void;
    mockScanForAccounts.mockImplementation(
      () =>
        new Promise<unknown[]>(res => {
          release = res;
        })
    );
    await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });

    await act(async () => {
      captured.onAction!({ id: 'scan-more-accounts', payload: { count: 5 } });
    });
    expect(captured.props?.isScanning).toBe(true);

    await act(async () => {
      release([]);
    });
    expect(captured.props?.isScanning).toBe(false);
  });

  it('recovered-accounts-continue enters the wallet via the post-onboarding route', async () => {
    mockPostOnboardingRoute.mockReturnValue('/finish-side-panel');
    await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });
    expect(mockNavigate).not.toHaveBeenCalled();

    await dispatch({ id: 'recovered-accounts-continue' });
    expect(mockNavigate).toHaveBeenCalledWith('/finish-side-panel');
  });

  it('mobile back on the recovered-accounts overview is consumed without leaving', async () => {
    const { container } = await importToConfirmation('https://chosen.example.com');
    await dispatch({ id: 'confirmation' });

    let result!: boolean | void;
    await act(async () => {
      result = captured.backHandler!();
    });
    expect(result).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.RecoveredAccounts);
  });

  it('confirmation (Create flow after an abandoned import): never adopts the abandoned probe', async () => {
    mockProbeStart.mockResolvedValue(PROBED_RESULT);

    renderPage();
    // Start an import, kick the probe…
    await dispatch({ id: 'select-import-type' });
    await dispatch({ id: 'import-seed-phrase-submit', payload: 'seed words here' });
    // …then abandon it and create a fresh wallet instead.
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    // Leaving the import path discards the probe, and the create-path
    // confirmation must not adopt the abandoned seed's detected guardian — the
    // threaded endpoint stays undefined (detection only runs on the Import path).
    expect(mockProbeReset).toHaveBeenCalled();
    expect(mockPutToStorage).not.toHaveBeenCalled();
    expect(mockRegisterWallet).toHaveBeenCalledWith(
      WalletType.Guardian,
      'secret',
      'fmt:a b c d e f g h i j k l',
      false,
      undefined
    );
  });

  it('confirmation (Create flow) reports a registerWallet rejection instead of swallowing it (#630)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('register failed');
    mockRegisterWallet.mockRejectedValueOnce(boom);

    renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });
    await dispatch({ id: 'confirmation' });

    expect(mockRegisterWallet).toHaveBeenCalled();
    // Still logged for diagnostics...
    expect(errSpy).toHaveBeenCalledWith(boom);
    // ...but no longer ONLY logged: the reason reaches the screen and the flow
    // does not navigate away from a wallet it has already wiped.
    expect(captured.props?.recoveryError).toContain('register failed');
    expect(mockNavigate).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // onAction — back branches
  // -------------------------------------------------------------------------
  it('back from VerifySeedPhrase → BackupSeedPhrase', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'verify-seed-phrase' });
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.BackupSeedPhrase);
  });

  it('back from BackupSeedPhrase → Welcome', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'backup-seed-phrase' });
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Welcome);
  });

  it('back from CreatePassword in the Create flow → VerifySeedPhrase', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'create-wallet' }); // onboardingType = Create
    await dispatch({ id: 'create-password' }); // step = CreatePassword
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.VerifySeedPhrase);
  });

  it('back from CreatePassword in the Import flow → ImportFromSeed', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'select-import-type' }); // onboardingType = Import
    await dispatch({ id: 'create-password' }); // step = CreatePassword
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.ImportFromSeed);
  });

  it('back from ImportFromSeed → Welcome', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'import-from-seed' });
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Welcome);
  });

  it('back from Welcome (no matching branch) is a no-op', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'back' });
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Welcome);
  });

  // -------------------------------------------------------------------------
  // useMobileBackHandler closure branches
  // -------------------------------------------------------------------------
  it('mobile back on Welcome: navigates home and consumes the event', () => {
    renderPage();
    const result = captured.backHandler!();
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(result).toBe(true);
  });

  it('mobile back on a non-Welcome step: triggers the back action and consumes', async () => {
    const { container } = renderPage();
    await dispatch({ id: 'select-import-type' }); // step = ImportFromSeed
    let result!: boolean | void;
    await act(async () => {
      result = captured.backHandler!();
    });
    expect(result).toBe(true);
    // The back action ran, taking ImportFromSeed → Welcome.
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Welcome);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('mobile back on the Confirmation step while loading: consumes without navigating', async () => {
    // Hold register() pending so the component stays in the isLoading=true /
    // step=Confirmation render while we probe the back handler.
    let release!: () => void;
    mockRegisterWallet.mockImplementationOnce(
      () =>
        new Promise<void>(res => {
          release = res;
        })
    );

    const { container } = renderPage();
    await dispatch({ id: 'create-wallet' });
    await dispatch({ id: 'create-password-submit', payload: { password: 'secret' } });

    // Kick off confirmation but do NOT await it — register stays pending, so the
    // committed render has step=Confirmation and isLoading=true.
    await act(async () => {
      captured.onAction!({ id: 'confirmation' });
    });
    expect(flow(container).getAttribute('data-loading')).toBe('true');
    expect(flow(container).getAttribute('data-step')).toBe(OnboardingStep.Confirmation);

    const result = captured.backHandler!();
    expect(result).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();

    // Let the pending register resolve so the flow completes cleanly.
    await act(async () => {
      release();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
