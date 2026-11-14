import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import { setAutoConsume } from './test-dapp';
import { blockMainnetConsumeAuthorization } from './mainnet-consume-authorization';

export async function restoreMainnetLoopGuardian(wallet: GuardianAwareWalletPage, keyPair: string): Promise<void> {
  if (!keyPair.trim()) throw new Error('Existing mainnet Guardian key pair is required');
  await blockMainnetConsumeAuthorization(wallet.page);
  await setAutoConsume(wallet, false);
  await wallet.recoverGuardianFromHotKey(keyPair.trim());
  await blockMainnetConsumeAuthorization(wallet.page);
  await wallet.triggerSync(true);
}
