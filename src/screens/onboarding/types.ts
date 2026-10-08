import type { DecryptedWalletFile } from 'lib/miden/backup-file';
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

/** Sentinel guardianId meaning "create a no-guardian account" (dev-gated). */
export const NO_GUARDIAN_ID = 'no-guardian';

export enum OnboardingType {
  Create = 'create',
  Import = 'import'
}

export enum WalletType {
  OffChain = 'off-chain',
  Guardian = 'guardian',
  OnChain = 'on-chain'
}

export enum ImportType {
  SeedPhrase = 'seed-phrase',
  WalletFile = 'wallet-file'
}

export enum OnboardingStep {
  Welcome = 'welcome',
  NetworkNotice = 'network-notice',
  SelectWalletType = 'select-wallet-type',
  ChooseProtection = 'choose-protection',
  SetupPasscode = 'setup-passcode',
  SetupBiometric = 'setup-biometric',
  BackupSeedPhrase = 'backup-seed-phrase',
  VerifySeedPhrase = 'verify-seed-phrase',
  ImportFromSeed = 'import-from-seed',
  ImportFromKey = 'import-from-key',
  CreatePassword = 'create-password',
  BiometricSetup = 'biometric-setup',
  SelectImportType = 'select-import-type',
  ImportFromFile = 'import-from-file',
  SelectTransactionType = 'select-transaction-type',
  SelectRecoveryMethod = 'select-recovery-method',
  /** The create flow's first guardian screen: what a Guardian does for the user, before any operator is named. */
  GuardianIntro = 'guardian-intro',
  /**
   * The create flow's second guardian screen: the fastest reachable operator, picked for the user and
   * introduced on its own, with a Change provider action that opens the operator sheet. Continue opens
   * once the chosen operator has answered online. The full-page picker, `ChooseGuardian`, is Rotate
   * Guardian's alone.
   */
  MeetGuardian = 'meet-guardian',
  ImportSelectRecoveryMethod = 'import-select-recovery-method',
  Confirmation = 'confirmation'
}
/** Every onboarding action id, derived from the action union so the two cannot drift. */
export type OnboardingActionId = OnboardingAction['id'];

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

/** Leave the guardian intro for the operator screen. */
export type GuardianIntroSubmitAction = {
  id: 'guardian-intro-submit';
};

export type ChooseGuardianSubmitAction = {
  id: 'choose-guardian-submit';
  payload: { guardianId: string; guardianEndpoint: string };
};

export type SelectImportTypeAction = {
  id: 'select-import-type';
};

export type NetworkNoticeAcknowledgeAction = {
  id: 'network-notice-acknowledge';
};

export type ImportFromSeedAction = {
  id: 'import-from-seed';
};

export type ImportFromFileAction = {
  id: 'import-from-file';
};

/** Switch the import flow from seed-phrase entry to hot-key paste. */
export type ImportWithKeyAction = {
  id: 'import-with-key';
};

/** Submit the pasted hot key (normalized hex) from the key-paste screen. */
export type ImportHotKeySubmitAction = {
  id: 'import-hot-key-submit';
  payload: string;
};

export type ImportWalletFileSubmitAction = {
  id: 'import-wallet-file-submit';
  payload: DecryptedWalletFile;
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

/**
 * What the user has done on the Meet your Guardian step: the operator locked in. The flow owns it, not
 * the step, so leaving the step and coming back leaves it as it was.
 */
export interface MeetGuardianProgress {
  chosenId: string | null;
  /**
   * The fastest operator of the first full round that had one online, tagged Fastest in the provider sheet.
   * Recorded once, whatever is chosen by then, and never moved by a later round.
   */
  fastestId: string | null;
}

export const EMPTY_MEET_GUARDIAN_PROGRESS: MeetGuardianProgress = { chosenId: null, fastestId: null };

export type ImportSelectRecoveryMethodAction = {
  id: 'import-select-recovery-method';
  payload: { walletType: WalletType; guardianEndpoint?: string };
};

export type ConfirmationAction = {
  id: 'confirmation';
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
  | GuardianIntroSubmitAction
  | ChooseGuardianSubmitAction
  | BackupSeedPhraseAction
  | SelectImportTypeAction
  | NetworkNoticeAcknowledgeAction
  | VerifySeedPhraseAction
  | CreatePasswordAction
  | CreatePasswordSubmitAction
  | BiometricSetupSubmitAction
  | SelectTransactionTypeAction
  | SelectRecoveryMethodAction
  | ImportSelectRecoveryMethodAction
  | ConfirmationAction
  | ImportSeedPhraseSubmitAction
  | BackAction
  | ImportFromSeedAction
  | ImportFromFileAction
  | ImportWalletFileSubmitAction
  | ImportWithKeyAction
  | ImportHotKeySubmitAction
  | RetryGuardianProbeAction
  | SwitchToPasswordAction;

// TODO: Potentially make this into what the onboarding flows use to render the
// steps rather than hardcode the path in onboarding flow
export type OnboardingPlan = {
  steps: OnboardingStep[]; // Order maintained
};
