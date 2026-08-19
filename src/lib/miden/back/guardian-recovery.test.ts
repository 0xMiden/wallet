import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { maybeStartGuardianRecovery } from './guardian-recovery';
import { Vault } from './vault';

describe('maybeStartGuardianRecovery', () => {
  it('does not start recovery for an account without the pending marker', async () => {
    const account: WalletAccount = {
      publicKey: 'account-a',
      name: 'Account 1',
      isPublic: false,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa'
    };
    const vaultKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);

    await expect(maybeStartGuardianRecovery(account, new Vault(vaultKey))).resolves.toBe(false);
  });
});
