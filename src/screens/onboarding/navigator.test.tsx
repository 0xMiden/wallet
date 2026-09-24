import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { pageSlideDim, pageSlideEntrance, pageSlideParallax, presets, reducedMotionTransition } from 'lib/animation';

import { OnboardingFlow } from './navigator';
import { ImportType, OnboardingStep, OnboardingType, WalletType } from './types';

// ---------------------------------------------------------------------------
// Mutable mock state. The factories below close over these `mock*`-prefixed
// objects so a single test can drive the platform / reduced-motion branches
// without re-mocking.
// ---------------------------------------------------------------------------
const mockPlatform = { isMobile: false };
let mockReduceMotion: boolean | null = false;

// Every child screen stores the props it last received here, keyed by a short
// name. Tests grab the captured callback and invoke it with a chosen payload to
// exercise the `renderStep` inner handlers (and their switch branches).
const mockCaptured: Record<string, any> = {};

// The step container's motion props (the only motion element with `variants`)
// and the props of every AnimatePresence, as last rendered.
const mockMotion: { step: any; dim: any; presences: any[] } = { step: null, dim: null, presences: [] };

// A screen stub: records props under `name` and renders an identifiable node.
function mockScreen(name: string) {
  return (props: any) => {
    mockCaptured[name] = props;
    return require('react').createElement('div', { 'data-testid': `screen-${name}` });
  };
}

// ---------------------------------------------------------------------------
// Framework / platform mocks
// ---------------------------------------------------------------------------

// `react-i18next` — echo the key so labels are assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `framer-motion` — AnimatePresence is a passthrough that records its props;
// `motion.*` records the step container's animation props, drops them and
// renders a plain div; `useReducedMotion` reads the shared toggle.
jest.mock('framer-motion', () => {
  const R = require('react');
  return {
    AnimatePresence: ({ children, ...presence }: { children: React.ReactNode }) => {
      mockMotion.presences.push(presence);
      return R.createElement(R.Fragment, null, children);
    },
    PresenceContext: R.createContext(null),
    motion: new Proxy(
      {},
      {
        get:
          () =>
          ({ children, initial, animate, exit, transition, variants, custom, ...rest }: any) => {
            // The step layer carries the layer marker; its dim is the other variant-bearing child,
            // captured too so the motion targets can be read off what the layer was GIVEN rather
            // than off a symbol the module would otherwise have to export for tests alone.
            if (variants && rest['data-onboarding-step-layer'])
              mockMotion.step = { initial, animate, exit, transition, variants, custom };
            else if (variants) mockMotion.dim = { initial, animate, exit, transition, variants, custom };
            return R.createElement('div', rest, children);
          }
      }
    ),
    useReducedMotion: () => mockReduceMotion
  };
});

// Platform detector — reads the shared toggle so mobile/desktop branches
// (protectionChoiceSkipped, transition duration) are both reachable.
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile
}));

// Dev-gated "No guardian" onboarding flag — reads the shared toggle so a test
// can drive whether ChooseGuardianScreen is told to show the option.
let mockAllowNoGuardian = false;
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveAllowNoGuardian: () => mockAllowNoGuardian
}));

// `ProgressIndicator` — expose currentStep / steps / className as data attrs so
// every progress-computation branch is assertable.
jest.mock('components/ProgressIndicator', () => ({
  ProgressIndicator: ({ currentStep, steps, className }: any) =>
    require('react').createElement('div', {
      'data-testid': 'progress',
      'data-current': String(currentStep),
      'data-steps': String(steps),
      'data-classname': className
    })
}));

// ---------------------------------------------------------------------------
// Child-screen mocks — one per import, capturing props for callback assertions.
// ---------------------------------------------------------------------------
jest.mock('./common/Welcome', () => ({ WelcomeScreen: (p: any) => mockScreen('welcome')(p) }));
jest.mock('./common/ChooseProtection', () => ({
  ChooseProtectionScreen: (p: any) => mockScreen('choose-protection')(p)
}));
jest.mock('./common/Confirmation', () => ({ ConfirmationScreen: (p: any) => mockScreen('confirmation')(p) }));
jest.mock('./common/NetworkNotice', () => ({ NetworkNoticeScreen: (p: any) => mockScreen('network-notice')(p) }));
jest.mock('./common/CreatePassword', () => ({ CreatePasswordScreen: (p: any) => mockScreen('create-password')(p) }));
jest.mock('./common/SetupBiometric', () => ({ SetupBiometricScreen: (p: any) => mockScreen('setup-biometric')(p) }));
jest.mock('./common/SetupPasscode', () => ({ SetupPasscodeScreen: (p: any) => mockScreen('setup-passcode')(p) }));
jest.mock('./common/ChooseGuardian', () => ({ ChooseGuardianScreen: (p: any) => mockScreen('choose-guardian')(p) }));
jest.mock('./common/MeetGuardian', () => ({ MeetGuardianScreen: (p: any) => mockScreen('meet-guardian')(p) }));
jest.mock('./create-wallet-flow/BackUpSeedPhrase', () => ({
  BackUpSeedPhraseScreen: (p: any) => mockScreen('backup-seed')(p)
}));
jest.mock('./create-wallet-flow/SelectRecoveryMethod', () => ({
  SelectRecoveryMethodScreen: (p: any) => mockScreen('select-recovery')(p)
}));
jest.mock('./create-wallet-flow/SelectTransactionType', () => ({
  SelectTransactionTypeScreen: (p: any) => mockScreen('select-transaction')(p)
}));
jest.mock('./create-wallet-flow/VerifySeedPhrase', () => ({
  VerifySeedPhraseScreen: (p: any) => mockScreen('verify-seed')(p)
}));
jest.mock('./import-wallet-flow/ImportRecoveryMethod', () => ({
  ImportRecoveryMethodScreen: (p: any) => mockScreen('import-recovery')(p)
}));
jest.mock('./import-wallet-flow/ImportSeedPhrase', () => ({
  ImportSeedPhraseScreen: (p: any) => mockScreen('import-seed')(p)
}));
jest.mock('./import-wallet-flow/SelectImportType', () => ({
  SelectImportTypeScreen: (p: any) => mockScreen('select-import-type')(p)
}));
jest.mock('./import-wallet-flow/ImportWalletFile', () => ({
  ImportWalletFileScreen: (p: any) => mockScreen('import-wallet-file')(p)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const baseProps = {
  wordslist: ['alpha', 'bravo', 'charlie'],
  seedPhrase: ['one', 'two', 'three'],
  onboardingType: OnboardingType.Create as OnboardingType | null,
  step: OnboardingStep.Welcome
};

const renderFlow = (overrides: Record<string, any> = {}) => render(<OnboardingFlow {...baseProps} {...overrides} />);

const progress = () => screen.queryByTestId('progress');

beforeEach(() => {
  mockPlatform.isMobile = false;
  mockReduceMotion = false;
  mockAllowNoGuardian = false;
  mockMotion.step = null;
  mockMotion.dim = null;
  mockMotion.presences = [];
  for (const k of Object.keys(mockCaptured)) delete mockCaptured[k];
});

describe('OnboardingFlow — per-step rendering, header & back-button visibility', () => {
  it('renders the Welcome screen with no header and no back button', () => {
    renderFlow({ step: OnboardingStep.Welcome });
    expect(screen.getByTestId('screen-welcome')).toBeInTheDocument();
    expect(progress()).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-back')).not.toBeInTheDocument();
    expect(document.querySelector('[data-onboarding-root="true"]')).toBeInTheDocument();
  });

  // Every step after Welcome carries the header's back chevron: steps whose own footer used to hold
  // a Back button and steps (protection, passcode, guardian) that had no way back at all.
  const headerWithBack: Array<[OnboardingStep, string]> = [
    [OnboardingStep.NetworkNotice, 'screen-network-notice'],
    [OnboardingStep.ChooseProtection, 'screen-choose-protection'],
    [OnboardingStep.SetupPasscode, 'screen-setup-passcode'],
    [OnboardingStep.SetupBiometric, 'screen-setup-biometric'],
    [OnboardingStep.MeetGuardian, 'screen-meet-guardian'],
    [OnboardingStep.ChooseGuardian, 'screen-choose-guardian'],
    [OnboardingStep.BackupSeedPhrase, 'screen-backup-seed'],
    [OnboardingStep.VerifySeedPhrase, 'screen-verify-seed'],
    [OnboardingStep.SelectImportType, 'screen-select-import-type'],
    [OnboardingStep.ImportFromSeed, 'screen-import-seed'],
    [OnboardingStep.ImportFromFile, 'screen-import-wallet-file'],
    [OnboardingStep.CreatePassword, 'screen-create-password'],
    [OnboardingStep.SelectRecoveryMethod, 'screen-select-recovery'],
    [OnboardingStep.ImportSelectRecoveryMethod, 'screen-import-recovery'],
    [OnboardingStep.SelectTransactionType, 'screen-select-transaction'],
    [OnboardingStep.Confirmation, 'screen-confirmation']
  ];
  it.each(headerWithBack)('renders %s with the header, its progress and a back chevron', (step, testid) => {
    // Use Import so the mobile-independent create-shortening doesn't interfere.
    renderFlow({ step, onboardingType: OnboardingType.Import });
    expect(screen.getByTestId(testid)).toBeInTheDocument();
    expect(progress()).toBeInTheDocument();
    const back = screen.getByTestId('onboarding-back');
    expect(back).toHaveAccessibleName('back');
  });

  it('hides the chevron where the host says the step cannot be left (a wallet being created)', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.Confirmation, canGoBack: false, onAction });
    expect(progress()).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-back')).not.toBeInTheDocument();
  });

  it('renders an empty screen (default switch case) with a back button for an unmapped step', () => {
    renderFlow({ step: OnboardingStep.BiometricSetup, onboardingType: OnboardingType.Import });
    // No child screen stub rendered for the default case.
    expect(document.querySelector('[data-testid^="screen-"]')).toBeNull();
    // Header still shows (not Welcome) and the back button shows (not excluded).
    expect(progress()).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-back')).toBeInTheDocument();
  });
});

describe('OnboardingFlow — action wiring per screen', () => {
  it('Welcome: routes select-wallet-type / select-import-type and ignores unknown', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.Welcome, onAction });

    act(() => mockCaptured.welcome.onSubmit('select-wallet-type'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'choose-protection' });

    act(() => mockCaptured.welcome.onSubmit('select-import-type'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'select-import-type' });

    onAction.mockClear();
    act(() => mockCaptured.welcome.onSubmit('nonsense'));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('NetworkNotice: acknowledging dispatches network-notice-acknowledge', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.NetworkNotice, onAction });
    act(() => mockCaptured['network-notice'].onSubmit());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'network-notice-acknowledge' });
  });

  it('Welcome: does not throw when onAction is omitted (optional chaining)', () => {
    renderFlow({ step: OnboardingStep.Welcome });
    expect(() => act(() => mockCaptured.welcome.onSubmit('select-wallet-type'))).not.toThrow();
    expect(() => act(() => mockCaptured.welcome.onSubmit('select-import-type'))).not.toThrow();
  });

  it('ChooseProtection: wires biometric and passcode selections', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.ChooseProtection, onAction });

    act(() => mockCaptured['choose-protection'].onSelectBiometric());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'setup-biometric' });

    act(() => mockCaptured['choose-protection'].onSelectPasscode());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'setup-passcode' });
  });

  it('SetupPasscode: submits the code and bumps progress on phase change', () => {
    const onAction = jest.fn();
    // Mobile so protection is NOT skipped: progressOverride shows directly.
    mockPlatform.isMobile = true;
    renderFlow({ step: OnboardingStep.SetupPasscode, onAction });

    act(() => mockCaptured['setup-passcode'].onSubmit('4242'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'setup-passcode-submit', payload: '4242' });

    act(() => mockCaptured['setup-passcode'].onPhaseChange('enter'));
    expect(progress()).toHaveAttribute('data-current', '2');

    act(() => mockCaptured['setup-passcode'].onPhaseChange('confirm'));
    expect(progress()).toHaveAttribute('data-current', '3');
  });

  it('SetupBiometric: wires continue and switch-to-passcode', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.SetupBiometric, onAction });

    act(() => mockCaptured['setup-biometric'].onContinue());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'setup-biometric-submit' });

    act(() => mockCaptured['setup-biometric'].onSwitchToPasscode());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'setup-passcode' });
  });

  it('ChooseGuardian: forwards the guardian payload', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.ChooseGuardian, onAction });

    const payload = { guardianId: 'g1', guardianEndpoint: 'https://guardian.example' };
    act(() => mockCaptured['choose-guardian'].onSubmit(payload));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'choose-guardian-submit', payload });
  });

  it('ChooseGuardian: forwards the dev-gated allow-no-guardian flag as showNoGuardianOption', () => {
    mockAllowNoGuardian = true;
    renderFlow({ step: OnboardingStep.ChooseGuardian });
    expect(mockCaptured['choose-guardian'].showNoGuardianOption).toBe(true);
  });

  it('ChooseGuardian: hides the no-guardian option when the dev flag is off', () => {
    mockAllowNoGuardian = false;
    renderFlow({ step: OnboardingStep.ChooseGuardian });
    expect(mockCaptured['choose-guardian'].showNoGuardianOption).toBe(false);
  });

  it('MeetGuardian: submits the picked guardian, opens the picker, and carries the dev flag', () => {
    const onAction = jest.fn();
    mockAllowNoGuardian = true;
    renderFlow({ step: OnboardingStep.MeetGuardian, onAction });
    expect(mockCaptured['meet-guardian'].showNoGuardianOption).toBe(true);

    const payload = { guardianId: 'g1', guardianEndpoint: 'https://guardian.example' };
    act(() => mockCaptured['meet-guardian'].onSubmit(payload));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'choose-guardian-submit', payload });

    act(() => mockCaptured['meet-guardian'].onChooseDifferent());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'choose-guardian' });
  });

  it('MeetGuardian and ChooseGuardian sit at the same progress position', () => {
    const { unmount } = renderFlow({ step: OnboardingStep.MeetGuardian, onboardingType: OnboardingType.Create });
    const meetProgress = screen.getByTestId('progress').getAttribute('data-current');
    unmount();
    renderFlow({ step: OnboardingStep.ChooseGuardian, onboardingType: OnboardingType.Create });
    expect(screen.getByTestId('progress').getAttribute('data-current')).toBe(meetProgress);
  });

  it('BackupSeedPhrase: passes the seed phrase through and submits verify', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, seedPhrase: ['a', 'b'], onAction });
    expect(mockCaptured['backup-seed'].seedPhrase).toEqual(['a', 'b']);

    act(() => mockCaptured['backup-seed'].onSubmit());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'verify-seed-phrase' });
  });

  it('BackupSeedPhrase: defaults a null seed phrase to []', () => {
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, seedPhrase: null });
    expect(mockCaptured['backup-seed'].seedPhrase).toEqual([]);
  });

  it('VerifySeedPhrase: defaults a null seed phrase to [] and submits create-password', () => {
    const onAction = jest.fn();
    const onBiometricChange = jest.fn();
    renderFlow({
      step: OnboardingStep.VerifySeedPhrase,
      seedPhrase: null,
      useBiometric: true,
      isHardwareSecurityAvailable: true,
      onBiometricChange,
      onAction
    });
    expect(mockCaptured['verify-seed'].seedPhrase).toEqual([]);
    expect(mockCaptured['verify-seed'].useBiometric).toBe(true);
    expect(mockCaptured['verify-seed'].isHardwareSecurityAvailable).toBe(true);
    expect(mockCaptured['verify-seed'].onBiometricChange).toBe(onBiometricChange);

    act(() => mockCaptured['verify-seed'].onSubmit());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'create-password', payload: WalletType.OnChain });
  });

  it('ImportFromSeed: passes wordslist and submits the entered phrase', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.ImportFromSeed, wordslist: ['w1', 'w2'], onAction });
    expect(mockCaptured['import-seed'].wordslist).toEqual(['w1', 'w2']);

    act(() => mockCaptured['import-seed'].onSubmit('my phrase'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'import-seed-phrase-submit', payload: 'my phrase' });
  });

  it('SelectImportType: routes seed phrase and encrypted wallet file choices', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.SelectImportType, onAction });

    act(() => mockCaptured['select-import-type'].onSubmit(ImportType.SeedPhrase));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'import-from-seed' });

    act(() => mockCaptured['select-import-type'].onSubmit(ImportType.WalletFile));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'import-from-file' });

    onAction.mockClear();
    act(() => mockCaptured['select-import-type'].onSubmit('unknown'));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('ImportFromFile: forwards one parsed restore payload', () => {
    const onAction = jest.fn();
    const payload = {
      formatVersion: 2 as const,
      seedPhrase: 'seed words',
      midenClientDbContent: 'miden-db',
      walletDbContent: 'wallet-db',
      accounts: [],
      importedAccounts: []
    };
    renderFlow({ step: OnboardingStep.ImportFromFile, onAction });

    act(() => mockCaptured['import-wallet-file'].onSubmit(payload));

    expect(onAction).toHaveBeenLastCalledWith({ id: 'import-wallet-file-submit', payload });
  });

  it('CreatePassword: submits password with biometric disabled', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.CreatePassword, onboardingType: OnboardingType.Import, onAction });

    act(() => mockCaptured['create-password'].onSubmit('hunter2'));
    expect(onAction).toHaveBeenLastCalledWith({
      id: 'create-password-submit',
      payload: { password: 'hunter2', enableBiometric: false }
    });
  });

  it('SelectRecoveryMethod: forwards the chosen wallet type', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.SelectRecoveryMethod, onAction });

    act(() => mockCaptured['select-recovery'].onSubmit(WalletType.Guardian));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'select-recovery-method', payload: WalletType.Guardian });
  });

  it('ImportSelectRecoveryMethod: forwards isError and the submitted payload', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.ImportSelectRecoveryMethod, guardianLookupError: true, onAction });
    expect(mockCaptured['import-recovery'].isError).toBe(true);

    const payload = { walletType: WalletType.Guardian, guardianEndpoint: 'https://g.example' };
    act(() => mockCaptured['import-recovery'].onSubmit(payload));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'import-select-recovery-method', payload });
  });

  it('ImportSelectRecoveryMethod: isError is false by default', () => {
    renderFlow({ step: OnboardingStep.ImportSelectRecoveryMethod });
    expect(mockCaptured['import-recovery'].isError).toBe(false);
  });

  it('SelectTransactionType: submits with the private payload', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.SelectTransactionType, onAction });

    act(() => mockCaptured['select-transaction'].onSubmit());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'select-transaction-type', payload: 'private' });
  });

  it('Confirmation: forwards status props and wires submit / switch-to-password', () => {
    const onAction = jest.fn();
    renderFlow({
      step: OnboardingStep.Confirmation,
      isLoading: true,
      biometricAttempts: 3,
      biometricError: 'boom',
      confirmCreating: true,
      onAction
    });
    expect(mockCaptured.confirmation.isLoading).toBe(true);
    expect(mockCaptured.confirmation.biometricAttempts).toBe(3);
    expect(mockCaptured.confirmation.biometricError).toBe('boom');
    expect(mockCaptured.confirmation.creating).toBe(true);

    act(() => mockCaptured.confirmation.onSubmit());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'confirmation' });

    act(() => mockCaptured.confirmation.onSwitchToPassword());
    expect(onAction).toHaveBeenLastCalledWith({ id: 'switch-to-password' });
  });
});

describe('OnboardingFlow — back navigation', () => {
  it('back button fires the back action', () => {
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, onboardingType: OnboardingType.Import, onAction });

    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'back' });
  });

  it('back button does not throw when onAction is omitted', () => {
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, onboardingType: OnboardingType.Import });
    expect(() => fireEvent.click(screen.getByTestId('onboarding-back'))).not.toThrow();
  });
});

describe('OnboardingFlow — progress computation', () => {
  it('create flow on non-mobile shortens to 3 steps and shifts positions down by one', () => {
    // CreatePassword takes the SetupPasscode slot (2) then shifts to 1 of 3.
    renderFlow({ step: OnboardingStep.CreatePassword, onboardingType: OnboardingType.Create });
    expect(progress()).toHaveAttribute('data-steps', '3');
    expect(progress()).toHaveAttribute('data-current', '1');
  });

  it('create flow on mobile keeps 4 steps and the un-shifted position', () => {
    mockPlatform.isMobile = true;
    renderFlow({ step: OnboardingStep.CreatePassword, onboardingType: OnboardingType.Create });
    expect(progress()).toHaveAttribute('data-steps', '4');
    expect(progress()).toHaveAttribute('data-current', '3');
  });

  it('import flow keeps 4 steps and the mapped position', () => {
    renderFlow({ step: OnboardingStep.ImportFromSeed, onboardingType: OnboardingType.Import });
    expect(progress()).toHaveAttribute('data-steps', '4');
    expect(progress()).toHaveAttribute('data-current', '2');
  });

  it('file import choice and file upload occupy the first two import progress steps', () => {
    const { rerender } = render(
      <OnboardingFlow {...baseProps} step={OnboardingStep.SelectImportType} onboardingType={OnboardingType.Import} />
    );
    expect(progress()).toHaveAttribute('data-current', '1');

    rerender(
      <OnboardingFlow {...baseProps} step={OnboardingStep.ImportFromFile} onboardingType={OnboardingType.Import} />
    );
    expect(progress()).toHaveAttribute('data-current', '2');
  });

  it('shifted position of 0 keeps currentStep 0 and hides the indicator (opacity-0)', () => {
    // Create + non-mobile + ChooseProtection: base 1, shifted to 0 of 3.
    renderFlow({ step: OnboardingStep.ChooseProtection, onboardingType: OnboardingType.Create });
    expect(progress()).toHaveAttribute('data-steps', '3');
    expect(progress()).toHaveAttribute('data-current', '0');
    expect(progress()!.getAttribute('data-classname')).toContain('opacity-0');
  });

  it('unmapped step (import flow) yields a null position rendered as 1 and hidden', () => {
    // SelectTransactionType is absent from STEP_TO_PROGRESS → baseStep null.
    renderFlow({ step: OnboardingStep.SelectTransactionType, onboardingType: OnboardingType.Import });
    expect(progress()).toHaveAttribute('data-steps', '4');
    expect(progress()).toHaveAttribute('data-current', '1'); // currentStep ?? 1
    expect(progress()!.getAttribute('data-classname')).toContain('opacity-0');
  });

  it('unmapped step in the shortened create flow keeps a null (hidden) position', () => {
    // Create + non-mobile + unmapped step: protectionChoiceSkipped true, rawProgress null.
    renderFlow({ step: OnboardingStep.SelectTransactionType, onboardingType: OnboardingType.Create });
    expect(progress()).toHaveAttribute('data-steps', '3');
    expect(progress()).toHaveAttribute('data-current', '1');
    expect(progress()!.getAttribute('data-classname')).toContain('opacity-0');
  });

  it('a mapped step shows the indicator (no opacity-0 class)', () => {
    renderFlow({ step: OnboardingStep.ImportFromSeed, onboardingType: OnboardingType.Import });
    expect(progress()!.getAttribute('data-classname')).not.toContain('opacity-0');
  });

  it('resets the progress override when the top-level step changes', () => {
    mockPlatform.isMobile = true;
    const { rerender } = render(
      <OnboardingFlow {...baseProps} step={OnboardingStep.SetupPasscode} onboardingType={OnboardingType.Create} />
    );
    act(() => mockCaptured['setup-passcode'].onPhaseChange('confirm'));
    expect(progress()).toHaveAttribute('data-current', '3');

    // Navigating to a new step must clear the override (effect on [step]).
    rerender(
      <OnboardingFlow {...baseProps} step={OnboardingStep.ChooseGuardian} onboardingType={OnboardingType.Create} />
    );
    // ChooseGuardian base is 3; on mobile create flow (4 steps) it stays 3, but
    // the value now comes from baseStep, not the stale override.
    expect(progress()).toHaveAttribute('data-current', '3');
    expect(screen.getByTestId('screen-choose-guardian')).toBeInTheDocument();
  });
});

describe('OnboardingFlow — motion variants (reduced motion & direction)', () => {
  it('renders with reduced motion enabled', () => {
    mockReduceMotion = true;
    expect(() =>
      renderFlow({ step: OnboardingStep.ImportFromSeed, onboardingType: OnboardingType.Import })
    ).not.toThrow();
    expect(screen.getByTestId('screen-import-seed')).toBeInTheDocument();
  });

  it('evaluates the backward direction branch after a back navigation (motion enabled)', () => {
    mockReduceMotion = false;
    mockPlatform.isMobile = true; // exercises the animated step-transition branch
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, onboardingType: OnboardingType.Import, onAction });

    // Forward branch already evaluated on mount; clicking back flips direction
    // to 'backward' and re-renders, evaluating the backward variant branch.
    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'back' });
    expect(screen.getByTestId('screen-backup-seed')).toBeInTheDocument();
  });

  it('sets navigation direction forward on a forward action', () => {
    mockReduceMotion = false;
    const onAction = jest.fn();
    renderFlow({ step: OnboardingStep.Welcome, onAction });
    // A forward action re-renders with navigationDirection 'forward'.
    act(() => mockCaptured.welcome.onSubmit('select-wallet-type'));
    expect(onAction).toHaveBeenLastCalledWith({ id: 'choose-protection' });
  });

  it('crosses steps like pages: the step presence keeps both, handing the leaving one the direction', () => {
    renderFlow({ step: OnboardingStep.BackupSeedPhrase });
    // The header's presence still swaps one at a time; the steps' presence runs both at once.
    expect(mockMotion.presences).toContainEqual({ mode: 'wait', initial: false });
    expect(mockMotion.presences).toContainEqual({ initial: false, custom: 'forward' });
    expect(mockMotion.step).toMatchObject({ initial: 'enter', animate: 'center', exit: 'exit', custom: 'forward' });
    expect(typeof mockMotion.step.variants.enter).toBe('function');
  });

  it('on mobile, moves on the page preset: in from the right, the step beneath to the parallax', () => {
    mockPlatform.isMobile = true;
    renderFlow({ step: OnboardingStep.BackupSeedPhrase });
    expect(mockMotion.step.transition).toEqual(presets.page.transition);
    const enter = mockMotion.step.variants.enter as (d: string) => object;
    const exit = mockMotion.step.variants.exit as (d: string) => object;
    expect(enter('forward')).toEqual({ x: presets.page.initial?.x });
    expect(exit('forward')).toEqual({ x: pageSlideParallax });
    const dimExit = mockMotion.dim.variants.exit as (d: string) => object;
    expect(dimExit('forward')).toEqual({ opacity: pageSlideDim });
  });

  it('mirrors the move going back: uncovered from beneath, the leaving step out to the right', () => {
    mockPlatform.isMobile = true;
    renderFlow({ step: OnboardingStep.BackupSeedPhrase, onAction: jest.fn() });
    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(mockMotion.step.custom).toBe('backward');
    expect(mockMotion.presences).toContainEqual({ initial: false, custom: 'backward' });
    const enter = mockMotion.step.variants.enter as (d: string) => object;
    const exit = mockMotion.step.variants.exit as (d: string) => object;
    const dimEnter = mockMotion.dim.variants.enter as (d: string) => object;
    expect(enter('backward')).toEqual({ x: pageSlideParallax });
    expect(exit('backward')).toEqual({ x: presets.page.exit?.x });
    expect(dimEnter('backward')).toEqual({ opacity: pageSlideDim });
  });

  it('swaps steps at once off mobile, on the same curve', () => {
    mockPlatform.isMobile = false;
    renderFlow({ step: OnboardingStep.BackupSeedPhrase });
    expect(mockMotion.step.transition).toEqual({ ...pageSlideEntrance, duration: 0 });
  });

  it.each([true, false])('makes the move instant under reduced motion (mobile: %s)', mobile => {
    mockPlatform.isMobile = mobile;
    mockReduceMotion = true;
    renderFlow({ step: OnboardingStep.BackupSeedPhrase });
    expect(mockMotion.step.transition).toEqual(reducedMotionTransition);
  });
});
