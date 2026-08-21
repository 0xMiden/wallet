import type { GuardianDiscoveryResult } from 'lib/miden/guardian/discover';

/**
 * Progress of the background guardian auto-detection probe kicked off right
 * after seed-phrase entry (issue #418). Type-only import, so referencing this
 * never pulls the probe (and its SDK/guardian-client deps) into the onboarding
 * bundle — the probe itself is loaded dynamically.
 */
export type GuardianProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'done'; result: GuardianDiscoveryResult }
  | { status: 'error'; message: string };

export enum OnboardingType {
  Create = 'create',
  Import = 'import'
}

export enum WalletType {
  OffChain = 'off-chain',
  Guardian = 'guardian',
  OnChain = 'on-chain'
}

export enum OnboardingStep {
  Welcome = 'welcome',
  SelectWalletType = 'select-wallet-type',
  ChooseProtection = 'choose-protection',
  SetupPasscode = 'setup-passcode',
  SetupBiometric = 'setup-biometric',
  BackupSeedPhrase = 'backup-seed-phrase',
  VerifySeedPhrase = 'verify-seed-phrase',
  ImportFromSeed = 'import-from-seed',
  CreatePassword = 'create-password',
  BiometricSetup = 'biometric-setup',
  SelectTransactionType = 'select-transaction-type',
  SelectRecoveryMethod = 'select-recovery-method',
  ChooseGuardian = 'choose-guardian',
  ImportSelectRecoveryMethod = 'import-select-recovery-method',
  HelpImproveWallet = 'help-improve-wallet',
  Confirmation = 'confirmation'
}
export type OnboardingActionId =
  | 'select-wallet-type'
  | 'select-import-type'
  | 'choose-protection'
  | 'setup-passcode'
  | 'setup-passcode-submit'
  | 'setup-biometric'
  | 'setup-biometric-submit'
  | 'choose-guardian'
  | 'choose-guardian-submit'
  | 'create-wallet'
  | 'import-wallet'
  | 'backup-seed-phrase'
  | 'verify-seed-phrase'
  | 'create-password'
  | 'create-password-submit'
  | 'biometric-setup-submit'
  | 'select-transaction-type'
  | 'select-recovery-method'
  | 'choose-guardian'
  | 'import-select-recovery-method'
  | 'help-improve-wallet'
  | 'confirmation'
  | 'retry-guardian-probe'
  | 'import-from-seed';

export type CreateWalletAction = {
  id: 'create-wallet';
};

export type ChooseProtectionAction = {
  id: 'choose-protection';
};

export type SetupPasscodeAction = {
  id: 'setup-passcode';
};

export type SetupPasscodeSubmitAction = {
  id: 'setup-passcode-submit';
  payload: string;
};

export type SetupBiometricAction = {
  id: 'setup-biometric';
};

export type SetupBiometricSubmitAction = {
  id: 'setup-biometric-submit';
};

export type ChooseGuardianSubmitAction = {
  id: 'choose-guardian-submit';
  payload: { guardianId: string; guardianEndpoint: string };
};

export type SelectImportTypeAction = {
  id: 'select-import-type';
};

export type ImportFromSeedAction = {
  id: 'import-from-seed';
};

export type BackupSeedPhraseAction = {
  id: 'backup-seed-phrase';
};

export type VerifySeedPhraseAction = {
  id: 'verify-seed-phrase';
};

export type CreatePasswordAction = {
  id: 'create-password';
  payload: WalletType;
};

export type CreatePasswordSubmitAction = {
  id: 'create-password-submit';
  payload: { password: string; enableBiometric: boolean };
};

export type SelectTransactionTypeAction = {
  id: 'select-transaction-type';
  payload: string;
};

export type SelectRecoveryMethodAction = {
  id: 'select-recovery-method';
  payload: WalletType;
};

export type ChooseGuardianAction = {
  id: 'choose-guardian';
  payload: { guardianId: string; guardianEndpoint: string };
};

export type ImportSelectRecoveryMethodAction = {
  id: 'import-select-recovery-method';
  payload: { walletType: WalletType; guardianEndpoint?: string };
};

export type ConfirmationAction = {
  id: 'confirmation';
};

/**
 * The telemetry consent prompt was answered. Carries no payload: the answer
 * itself is already persisted by the screen, so the host only needs to move on.
 */
export type HelpImproveWalletAction = {
  id: 'help-improve-wallet';
};

export type BiometricSetupSubmitAction = {
  id: 'biometric-setup-submit';
  payload: boolean; // Whether biometric was enabled
};

export type ImportSeedPhraseSubmitAction = {
  id: 'import-seed-phrase-submit';
  payload: string;
};

export type BackAction = {
  id: 'back';
};

export type SwitchToPasswordAction = {
  id: 'switch-to-password';
};

/** Re-run the guardian auto-detection probe for the already-entered seed phrase. */
export type RetryGuardianProbeAction = {
  id: 'retry-guardian-probe';
};

export type OnboardingAction =
  | CreateWalletAction
  | ChooseProtectionAction
  | SetupPasscodeAction
  | SetupPasscodeSubmitAction
  | SetupBiometricAction
  | SetupBiometricSubmitAction
  | ChooseGuardianAction
  | ChooseGuardianSubmitAction
  | BackupSeedPhraseAction
  | SelectImportTypeAction
  | VerifySeedPhraseAction
  | CreatePasswordAction
  | CreatePasswordSubmitAction
  | BiometricSetupSubmitAction
  | SelectTransactionTypeAction
  | SelectRecoveryMethodAction
  | ChooseGuardianAction
  | ImportSelectRecoveryMethodAction
  | HelpImproveWalletAction
  | ConfirmationAction
  | ImportSeedPhraseSubmitAction
  | BackAction
  | ImportFromSeedAction
  | RetryGuardianProbeAction
  | SwitchToPasswordAction;

// TODO: Potentially make this into what the onboarding flows use to render the
// steps rather than hardcode the path in onboarding flow
export type OnboardingPlan = {
  steps: OnboardingStep[]; // Order maintained
};
