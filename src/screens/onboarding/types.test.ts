import { ImportType, OnboardingStep } from './types';

// The action union is a compile-time contract that `yarn ts` checks; asserting
// it at runtime would only compare a literal to itself, since the transform
// strips types. What the payload does end to end is covered by
// navigator.test.tsx and Welcome.test.tsx.
describe('encrypted wallet file onboarding types', () => {
  it('defines distinct import selection and file upload steps', () => {
    expect(OnboardingStep.SelectImportType).toBe('select-import-type');
    expect(OnboardingStep.ImportFromFile).toBe('import-from-file');
  });

  it('defines seed phrase and encrypted wallet file choices', () => {
    expect(ImportType.SeedPhrase).toBe('seed-phrase');
    expect(ImportType.WalletFile).toBe('wallet-file');
  });
});
