import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

export async function runMainnetNearStage(_wallet: GuardianAwareWalletPage, _mode: string): Promise<void> {
  throw new Error('Strict native NEAR stages are not implemented');
}
