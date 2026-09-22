import React, { FC, useCallback, useEffect, useState } from 'react';

import { AnimatePresence, useReducedMotion } from 'framer-motion';

import { PageHeader } from 'components/PageHeader';
import { ProgressIndicator } from 'components/ProgressIndicator';
import { pageSlideEntrance, usePreset } from 'lib/animation';
import type { DecryptedWalletFile } from 'lib/miden/backup-file';
import { getEffectiveAllowNoGuardian } from 'lib/miden-chain/effective-endpoints';
import { isMobile } from 'lib/platform';
import { cn } from 'lib/ui/util';

import { ChooseGuardianScreen } from './common/ChooseGuardian';
import { ChooseProtectionScreen } from './common/ChooseProtection';
import { ConfirmationScreen } from './common/Confirmation';
import { CreatePasswordScreen } from './common/CreatePassword';
import { NetworkNoticeScreen } from './common/NetworkNotice';
import { OnboardingStepLayer } from './common/OnboardingStepLayer';
import { SetupBiometricScreen } from './common/SetupBiometric';
import { SetupPasscodeScreen } from './common/SetupPasscode';
import { WelcomeScreen } from './common/Welcome';
import { BackUpSeedPhraseScreen } from './create-wallet-flow/BackUpSeedPhrase';
import { SelectRecoveryMethodScreen } from './create-wallet-flow/SelectRecoveryMethod';
import { SelectTransactionTypeScreen } from './create-wallet-flow/SelectTransactionType';
import { VerifySeedPhraseScreen } from './create-wallet-flow/VerifySeedPhrase';
import { ImportHotKeyScreen } from './import-wallet-flow/ImportHotKey';
import { ImportRecoveryMethodScreen } from './import-wallet-flow/ImportRecoveryMethod';
import { ImportSeedPhraseScreen } from './import-wallet-flow/ImportSeedPhrase';
import { ImportWalletFileScreen } from './import-wallet-flow/ImportWalletFile';
import { SelectImportTypeScreen } from './import-wallet-flow/SelectImportType';
import { GuardianProbeState, ImportType, OnboardingAction, OnboardingStep, OnboardingType, WalletType } from './types';

export interface OnboardingFlowProps {
  wordslist: readonly string[];
  seedPhrase: string[] | null;
  onboardingType: OnboardingType | null;
  step: OnboardingStep;
  password?: string | null;
  isLoading?: boolean;
  useBiometric?: boolean;
  isHardwareSecurityAvailable?: boolean;
  biometricAttempts?: number;
  biometricError?: string | null;
  guardianLookupError?: boolean;
  /** Registration/recovery failure text to surface on the confirmation step (#630). */
  recoveryError?: string | null;
  /**
   * Progress of the background guardian auto-detection probe (issue #418).
   * Left undefined by hosts that don't run the probe, which makes the import
   * recovery-method screen fall back to its classic manual picker.
   */
  guardianProbe?: GuardianProbeState;
  /** Side panel handoff (Chrome): wallet is being created in the background. */
  confirmCreating?: boolean;
  /**
   * The import flow is running on a pasted hot key rather than a seed phrase:
   * the recovery-method step pins Guardian (a hot key only ever belongs to a
   * Guardian multisig account).
   */
  importViaKey?: boolean;
  /**
   * Whether the header offers back. Hosts turn it off on a step that cannot be left safely (the
   * wallet is being created, or already exists). Welcome never shows it: nothing comes before it.
   */
  canGoBack?: boolean;
  onBiometricChange?: (value: boolean) => void;
  onAction?: (action: OnboardingAction) => void;
}

const STEP_TO_PROGRESS: Partial<Record<OnboardingStep, number>> = {
  [OnboardingStep.ChooseProtection]: 1,
  [OnboardingStep.SetupPasscode]: 2,
  [OnboardingStep.SetupBiometric]: 2,
  [OnboardingStep.ChooseGuardian]: 3,
  [OnboardingStep.SelectImportType]: 1,
  // This change inserts the import-type choice at tier 1, so seed entry moves to
  // tier 2 and the key-paste step, its sibling, moves with it.
  [OnboardingStep.ImportFromSeed]: 2,
  [OnboardingStep.ImportFromFile]: 2,
  [OnboardingStep.ImportFromKey]: 2,
  [OnboardingStep.BackupSeedPhrase]: 1,
  [OnboardingStep.VerifySeedPhrase]: 2,
  [OnboardingStep.CreatePassword]: 3,
  [OnboardingStep.SelectRecoveryMethod]: 4,
  [OnboardingStep.ImportSelectRecoveryMethod]: 4,
  [OnboardingStep.Confirmation]: 4
};

/**
 * Every step's header: the shared `PageHeader` row with the back chevron on the left and the flow's
 * progress centred in it. Back is the onboarding state machine's own step back (`onAction('back')`,
 * the same one the mobile back gesture takes), never the router's history.
 */
const Header: React.FC<{
  onBack?: () => void;
  currentStep: number | null;
  totalSteps: number;
}> = ({ onBack, currentStep, totalSteps }) => (
  <PageHeader
    className="relative px-4"
    onBack={onBack}
    backTestId="onboarding-back"
    actions={
      <ProgressIndicator
        currentStep={currentStep ?? 1}
        steps={totalSteps}
        // Centred on the row whether or not the chevron is there; decorative, the step's title says where you are.
        aria-hidden="true"
        className={cn('pointer-events-none absolute left-1/2 -translate-x-1/2', !currentStep && 'opacity-0')}
      />
    }
  />
);

export const OnboardingFlow: FC<OnboardingFlowProps> = ({
  wordslist,
  seedPhrase,
  onboardingType,
  step,
  isLoading,
  useBiometric = true,
  isHardwareSecurityAvailable = false,
  biometricAttempts = 0,
  biometricError = null,
  guardianLookupError = false,
  recoveryError = null,
  guardianProbe,
  confirmCreating = false,
  importViaKey = false,
  canGoBack = true,
  onBiometricChange,
  onAction
}) => {
  const reduceMotion = useReducedMotion();
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');

  // Override for screens that have internal sub-steps (e.g. SetupPasscode's
  // enter → confirm phase). Reset whenever the top-level step changes so the
  // bump doesn't leak across navigation.
  const [progressOverride, setProgressOverride] = useState<number | null>(null);
  useEffect(() => {
    setProgressOverride(null);
  }, [step]);
  // The choose-protection step only exists where biometric can work (mobile).
  // On the extension/desktop it's skipped, so the create flow is one step
  // shorter — render 3 segments and shift every position down by one.
  const protectionChoiceSkipped = onboardingType === OnboardingType.Create && !isMobile();
  // In that shortened create flow the password screen replaces passcode setup,
  // so it sits at the protection-step position rather than its import-flow one.
  const baseStep =
    step === OnboardingStep.CreatePassword && protectionChoiceSkipped
      ? (STEP_TO_PROGRESS[OnboardingStep.SetupPasscode] ?? null)
      : (STEP_TO_PROGRESS[step] ?? null);
  const rawProgress = progressOverride ?? baseStep;
  const totalSteps = protectionChoiceSkipped ? 3 : 4;
  const currentProgress = protectionChoiceSkipped && rawProgress !== null ? rawProgress - 1 : rawProgress;

  const onForwardAction = useCallback(
    (onboardingAction: OnboardingAction) => {
      setNavigationDirection('forward');
      onAction?.(onboardingAction);
    },
    [onAction]
  );

  const renderStep = useCallback(() => {
    const onWelcomeAction = (action: 'select-wallet-type' | 'select-import-type') => {
      switch (action) {
        case 'select-wallet-type':
          onForwardAction?.({
            id: 'choose-protection'
          });
          break;
        case 'select-import-type':
          onForwardAction?.({
            id: 'select-import-type'
          });
          break;
        default:
          break;
      }
    };

    const onNetworkNoticeSubmit = () => onForwardAction?.({ id: 'network-notice-acknowledge' });

    const onSelectImportTypeSubmit = (payload: ImportType) => {
      if (payload === ImportType.SeedPhrase) {
        onForwardAction?.({ id: 'import-from-seed' });
      } else if (payload === ImportType.WalletFile) {
        onForwardAction?.({ id: 'import-from-file' });
      }
    };

    const onBackupSeedPhraseSubmit = () =>
      onForwardAction?.({
        id: 'verify-seed-phrase'
      });

    const onVerifySeedPhraseSubmit = () =>
      onForwardAction?.({
        id: 'create-password',
        payload: WalletType.OnChain
      });

    const onCreatePasswordSubmit = (password: string) =>
      onForwardAction?.({ id: 'create-password-submit', payload: { password, enableBiometric: false } });

    const onSelectRecoveryMethodSubmit = (walletType: WalletType) =>
      onForwardAction?.({ id: 'select-recovery-method', payload: walletType });

    const onSelectTransactionTypeSubmit = () =>
      onForwardAction?.({ id: 'select-transaction-type', payload: 'private' });

    const onConfirmSubmit = () => onForwardAction?.({ id: 'confirmation' });

    const onSwitchToPassword = () => onForwardAction?.({ id: 'switch-to-password' });

    const onImportSeedPhraseSubmit = (seedPhrase: string) =>
      onForwardAction?.({ id: 'import-seed-phrase-submit', payload: seedPhrase });

    const onImportWalletFileSubmit = (payload: DecryptedWalletFile) =>
      onForwardAction?.({ id: 'import-wallet-file-submit', payload });

    const onSelectBiometric = () => onForwardAction?.({ id: 'setup-biometric' });
    const onSelectPasscode = () => onForwardAction?.({ id: 'setup-passcode' });
    const onSetupPasscodeSubmit = (code: string) => onForwardAction?.({ id: 'setup-passcode-submit', payload: code });
    const onSetupBiometricSubmit = () => onForwardAction?.({ id: 'setup-biometric-submit' });
    const onBiometricSwitchToPasscode = () => onForwardAction?.({ id: 'setup-passcode' });
    const onChooseGuardianSubmit = (payload: { guardianId: string; guardianEndpoint: string }) =>
      onForwardAction?.({ id: 'choose-guardian-submit', payload });

    switch (step) {
      case OnboardingStep.Welcome:
        return <WelcomeScreen onSubmit={onWelcomeAction} />;
      case OnboardingStep.NetworkNotice:
        return <NetworkNoticeScreen onSubmit={onNetworkNoticeSubmit} />;
      case OnboardingStep.ChooseProtection:
        return <ChooseProtectionScreen onSelectBiometric={onSelectBiometric} onSelectPasscode={onSelectPasscode} />;
      case OnboardingStep.SetupPasscode:
        return (
          <SetupPasscodeScreen
            onSubmit={onSetupPasscodeSubmit}
            onPhaseChange={phase => setProgressOverride(phase === 'enter' ? 2 : 3)}
          />
        );
      case OnboardingStep.SetupBiometric:
        return (
          <SetupBiometricScreen onContinue={onSetupBiometricSubmit} onSwitchToPasscode={onBiometricSwitchToPasscode} />
        );
      case OnboardingStep.ChooseGuardian:
        return (
          <ChooseGuardianScreen
            onSubmit={onChooseGuardianSubmit}
            showNoGuardianOption={getEffectiveAllowNoGuardian()}
          />
        );
      case OnboardingStep.BackupSeedPhrase:
        return <BackUpSeedPhraseScreen seedPhrase={seedPhrase || []} onSubmit={onBackupSeedPhraseSubmit} />;
      case OnboardingStep.VerifySeedPhrase:
        return (
          <VerifySeedPhraseScreen
            seedPhrase={seedPhrase || []}
            useBiometric={useBiometric}
            isHardwareSecurityAvailable={isHardwareSecurityAvailable}
            onBiometricChange={onBiometricChange}
            onSubmit={onVerifySeedPhraseSubmit}
          />
        );
      case OnboardingStep.ImportFromSeed:
        return (
          <ImportSeedPhraseScreen
            wordslist={wordslist}
            onSubmit={onImportSeedPhraseSubmit}
            onImportWithKey={() => onForwardAction?.({ id: 'import-with-key' })}
          />
        );
      case OnboardingStep.ImportFromKey:
        return (
          <ImportHotKeyScreen
            onSubmit={keyPairPayload => onForwardAction?.({ id: 'import-hot-key-submit', payload: keyPairPayload })}
          />
        );
      case OnboardingStep.SelectImportType:
        return <SelectImportTypeScreen onSubmit={onSelectImportTypeSubmit} />;
      case OnboardingStep.ImportFromFile:
        return <ImportWalletFileScreen onSubmit={onImportWalletFileSubmit} />;
      case OnboardingStep.CreatePassword:
        return <CreatePasswordScreen onSubmit={onCreatePasswordSubmit} />;
      case OnboardingStep.SelectRecoveryMethod:
        return <SelectRecoveryMethodScreen onSubmit={onSelectRecoveryMethodSubmit} />;
      case OnboardingStep.ImportSelectRecoveryMethod:
        return (
          <ImportRecoveryMethodScreen
            isError={guardianLookupError}
            probe={guardianProbe}
            guardianOnly={importViaKey}
            onRetryProbe={guardianProbe ? () => onForwardAction?.({ id: 'retry-guardian-probe' }) : undefined}
            onSubmit={payload => onForwardAction?.({ id: 'import-select-recovery-method', payload })}
          />
        );
      case OnboardingStep.SelectTransactionType:
        return <SelectTransactionTypeScreen onSubmit={onSelectTransactionTypeSubmit} />;
      case OnboardingStep.Confirmation:
        return (
          <ConfirmationScreen
            isLoading={isLoading}
            biometricAttempts={biometricAttempts}
            biometricError={biometricError}
            recoveryError={recoveryError}
            creating={confirmCreating}
            onSubmit={onConfirmSubmit}
            onSwitchToPassword={onSwitchToPassword}
          />
        );

      default:
        return <></>;
    }
  }, [
    step,
    isLoading,
    onForwardAction,
    seedPhrase,
    wordslist,
    useBiometric,
    isHardwareSecurityAvailable,
    onBiometricChange,
    biometricAttempts,
    biometricError,
    guardianLookupError,
    recoveryError,
    // Without this the recovery-method screen keeps rendering the first probe
    // state it saw and freezes on "detecting your guardian".
    guardianProbe,
    confirmCreating,
    importViaKey
  ]);

  const onBack = () => {
    setNavigationDirection('backward');
    onAction?.({ id: 'back' });
  };

  // A step moves like a pushed page (the `page` preset): going forward it slides in from the right
  // over the step it replaces, which parks at `pageSlideParallax` under the `pageSlideDim` dim; going
  // back the step on top slides out to the right and uncovers the one beneath. Only mobile animates
  // (the extension swaps at once, as its pages do), and reduced motion is instant everywhere.
  const pagePreset = usePreset('page');
  const stepTransition = reduceMotion || isMobile() ? pagePreset.transition : { ...pageSlideEntrance, duration: 0 };

  return (
    <div
      data-onboarding-root="true"
      className="mx-auto flex h-full w-full flex-col overflow-hidden bg-app-bg"
      style={{ maxWidth: 420 }}
    >
      <div className="flex flex-col flex-1 min-h-0">
        <AnimatePresence mode={'wait'} initial={false}>
          {step !== OnboardingStep.Welcome && (
            <Header
              onBack={canGoBack ? onBack : undefined}
              currentStep={currentProgress}
              totalSteps={totalSteps}
              key={'header'}
            />
          )}
        </AnimatePresence>
        {/* Both steps are on screen while they cross, stacked in one grid cell, as a page and the page
            beneath it are; the leaving one is inert (`OnboardingStepLayer`). `custom` hands the
            leaving step the direction of the move that removes it. */}
        <div className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden">
          <AnimatePresence initial={false} custom={navigationDirection}>
            <OnboardingStepLayer key={step} direction={navigationDirection} transition={stepTransition}>
              {renderStep()}
            </OnboardingStepLayer>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
