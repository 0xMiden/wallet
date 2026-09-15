import type { DecryptedWalletFile } from 'lib/miden/backup-file';

import { ImportType, OnboardingAction, OnboardingStep } from './types';

describe('encrypted wallet file onboarding types', () => {
  it('defines distinct import selection and file upload steps', () => {
    expect(OnboardingStep.SelectImportType).toBe('select-import-type');
    expect(OnboardingStep.ImportFromFile).toBe('import-from-file');
  });

  it('defines seed phrase and encrypted wallet file choices', () => {
    expect(ImportType.SeedPhrase).toBe('seed-phrase');
    expect(ImportType.WalletFile).toBe('wallet-file');
  });

  it('carries one parsed wallet file payload in the submit action', () => {
    const payload: DecryptedWalletFile = {
      formatVersion: 2,
      seedPhrase: 'seed words',
      midenClientDbContent: 'miden-db',
      walletDbContent: 'wallet-db',
      accounts: [],
      importedAccounts: []
    };
    const action: OnboardingAction = { id: 'import-wallet-file-submit', payload };

    expect(action).toEqual({ id: 'import-wallet-file-submit', payload });
  });
});
