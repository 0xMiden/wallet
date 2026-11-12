import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { setAutoConsume } from './test-dapp';

export async function restoreMainnetLoopGuardian(wallet: GuardianAwareWalletPage, keyPair: string): Promise<void> {
  if (!keyPair.trim()) throw new Error('Existing mainnet Guardian key pair is required');
  await setAutoConsume(wallet, false);
  await wallet.recoverGuardianFromHotKey(keyPair.trim());
  await wallet.triggerSync(true);
}
