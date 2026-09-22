import { AuthSecretKey } from '@miden-sdk/miden-sdk';

import { expect, test } from '../fixtures/two-wallets';

const WALLET_PASSWORD = 'Test1234!';
const FILE_PASSWORD = 'Backup1234!';
const RESTORED_PASSWORD = 'Restored1234!';
const IMPORTED_ACCOUNT_NAME = 'Restored signer';
const CHALLENGE_WORD = `0x${Array.from({ length: 32 }, (_, index) =>
  ((index * 17 + 3) & 0xff).toString(16).padStart(2, '0')
).join('')}`;

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// Skipped, not deleted: the export half of this flow drove Settings →
// Encrypted Wallet File, and that row is gone while a wallet holds a single
// Guardian account (see the security group in `app/pages/Settings.tsx`). The
// export flow itself stays in the code base, so this spec comes back with the row.
test.skip('an encrypted wallet file restores an imported account that can sign', async ({ walletA, walletB }) => {
  const privateKeySeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const privateKey = Buffer.from(AuthSecretKey.ecdsaWithRNG(privateKeySeed).serialize()).toString('hex');

  try {
    // A plain off-chain wallet on purpose: nothing here is guardian-specific, and
    // this suite is Tier-1 and deliberately brings up no guardian, so a guardian
    // wallet can never finish onboarding here (the endpoint card stays Offline).
    await walletA.createNewWallet(WALLET_PASSWORD);
    const sourceAccountId = await walletA.importPrivateKey(privateKey, IMPORTED_ACCOUNT_NAME);

    expect(await walletA.signAccountWord(sourceAccountId, CHALLENGE_WORD)).toMatch(/^0x[0-9a-f]+$/i);

    const backupPath = await walletA.exportEncryptedWalletFile({
      walletPassword: WALLET_PASSWORD,
      filePassword: FILE_PASSWORD,
      fileName: 'imported-account-restore'
    });

    await walletB.restoreEncryptedWalletFile({
      backupPath,
      filePassword: FILE_PASSWORD,
      newWalletPassword: RESTORED_PASSWORD
    });

    const restoredAccountId = await walletB.findAccountByName(IMPORTED_ACCOUNT_NAME);
    expect(restoredAccountId).toBe(sourceAccountId);

    await walletB.selectAccount(restoredAccountId);
    expect(await walletB.getAccountAddress()).toBe(sourceAccountId);
    expect(await walletB.signAccountWord(restoredAccountId, CHALLENGE_WORD)).toMatch(/^0x[0-9a-f]+$/i);
  } finally {
    privateKeySeed.fill(0);
  }
});
