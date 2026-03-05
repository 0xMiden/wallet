export enum OnboardingType {
  Create = 'create',
  Import = 'import'
}

export enum WalletType {
  OffChain = 'off-chain',
  OnChain = 'on-chain',
  Psm = 'psm'
}

export enum ImportType {
  SeedPhrase = 'seed-phrase',
  WalletFile = 'wallet-file'
}

export enum OnboardingStep {
  Welcome = 'welcome',
  SelectWalletType = 'select-wallet-type',
  BackupSeedPhrase = 'backup-seed-phrase',
  VerifySeedPhrase = 'verify-seed-phrase',
  SelectImportType = 'select-import-type',
  ImportFromSeed = 'import-from-seed',
  ImportFromFile = 'import-from-file',
  CreatePassword = 'create-password',
  BiometricSetup = 'biometric-setup',
  SelectTransactionType = 'select-transaction-type',
  Confirmation = 'confirmation'
}
export type OnboardingActionId =
  | 'select-wallet-type'
  | 'select-import-type'
  | 'create-wallet'
  | 'import-wallet'
  | 'backup-seed-phrase'
  | 'verify-seed-phrase'
  | 'create-password'
  | 'create-password-submit'
  | 'biometric-setup-submit'
  | 'select-transaction-type'
  | 'confirmation'
  | 'import-from-file'
  | 'import-from-seed';

export type CreateWalletAction = {
  id: 'create-wallet';
};

export type SelectImportTypeAction = {
  id: 'select-import-type';
};

export type ImportFromFileAction = {
  id: 'import-from-file';
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

export type ConfirmationAction = {
  id: 'confirmation';
};

export type BiometricSetupSubmitAction = {
  id: 'biometric-setup-submit';
  payload: boolean; // Whether biometric was enabled
};

export type ImportWalletFileSubmitAction = {
  id: 'import-wallet-file-submit';
  payload: string;
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

export type OnboardingAction =
  | CreateWalletAction
  | BackupSeedPhraseAction
  | SelectImportTypeAction
  | VerifySeedPhraseAction
  | CreatePasswordAction
  | CreatePasswordSubmitAction
  | BiometricSetupSubmitAction
  | SelectTransactionTypeAction
  | ConfirmationAction
  | ImportSeedPhraseSubmitAction
  | BackAction
  | ImportFromFileAction
  | ImportFromSeedAction
  | ImportWalletFileSubmitAction
  | SwitchToPasswordAction;

// TODO: Potentially make this into what the onboarding flows use to render the
// steps rather than hardcode the path in onboarding flow
export type OnboardingPlan = {
  steps: OnboardingStep[]; // Order maintained
};

export enum ForgotPasswordStep {
  Welcome = 'welcome',
  BackupSeedPhrase = 'backup-seed-phrase',
  VerifySeedPhrase = 'verify-seed-phrase',
  SelectImportType = 'select-import-type',
  ImportFromSeed = 'import-from-seed',
  ImportFromFile = 'import-from-file',
  CreatePassword = 'create-password',
  SelectTransactionType = 'select-transaction-type',
  Confirmation = 'confirmation'
}

export type ForgotPasswordAction =
  | CreateWalletAction
  | BackupSeedPhraseAction
  | VerifySeedPhraseAction
  | SelectTransactionTypeAction
  | SelectImportTypeAction
  | ImportFromSeedAction
  | ImportFromFileAction
  | ImportSeedPhraseSubmitAction
  | ImportWalletFileSubmitAction
  | CreatePasswordAction
  | CreatePasswordSubmitAction
  | ConfirmationAction
  | BackAction;
