import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

export async function restoreMainnetLoopGuardian(_wallet: GuardianAwareWalletPage, _keyPair: string): Promise<void> {
  throw new Error('Guarded mainnet Guardian restore is not implemented');
}
