import { AuthSecretKey } from '@miden-sdk/miden-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';

// Primary guardian operator for the selected network (E2E_NETWORK).
const A = getEnvironmentConfig().guardianUrl;
// recoverGuardianFromHotKey onboards with the harness password (wallet-page.ts PASSWORD).
const WALLET_PASSWORD = 'Test1234!';
const FILE_PASSWORD = 'Backup1234!';
const RESTORED_PASSWORD = 'Restored1234!';
const IMPORTED_ACCOUNT_NAME = 'Imported signer';
// Vault.spawnFromHotKey names the first adopted account "Account $accountNumber$".
const GUARDIAN_ACCOUNT_NAME = 'Account 1';
const CHALLENGE_WORD = `0x${Array.from({ length: 32 }, (_, index) =>
  ((index * 17 + 3) & 0xff).toString(16).padStart(2, '0')
).join('')}`;

/**
 * #1114: a wallet onboarded from a Guardian account's everyday and EVM keys that also holds
 * an imported private-key account writes its Encrypted Wallet File, the export screen names
 * the Guardian account the file leaves out before the user consents, and the file restores
 * into a fresh wallet with the imported account and no Guardian account.
 */
test.describe('a hot-key Guardian wallet file (#1114)', () => {
  // The export spends both fixture wallets on onboarding and the restore needs one still at
  // Welcome, which the next test's fresh fixtures give. Serial: it runs only after the export
  // passed, in the worker holding the values below.
  test.describe.configure({ mode: 'serial' });

  // The export saves into walletB's profile, which its teardown deletes.
  let handoffDir = '';
  let backupCopy = '';
  let guardianAddress = '';
  let importedAccountId = '';

  test.afterAll(() => {
    if (handoffDir) fs.rmSync(handoffDir, { recursive: true, force: true });
  });

  test('exports its imported account and names the account it leaves out (#1114)', async ({
    walletA,
    walletB,
    steps
  }, testInfo) => {
    test.setTimeout(480_000);

    let keyPairPayload = '';
    await steps.step('create_on_a_and_reveal_key_pair', async () => {
      guardianAddress = (await walletA.createGuardianWallet(A)).address;
      keyPairPayload = await walletA.revealHotKey();
    });

    await steps.step('import_both_keys_and_a_private_key_on_b', async () => {
      await walletB.recoverGuardianFromHotKey(keyPairPayload);
      expect(await walletB.findAccountByName(GUARDIAN_ACCOUNT_NAME)).toBe(guardianAddress);

      const privateKeySeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      try {
        const privateKey = Buffer.from(AuthSecretKey.ecdsaWithRNG(privateKeySeed).serialize()).toString('hex');
        importedAccountId = await walletB.importPrivateKey(privateKey, IMPORTED_ACCOUNT_NAME);
      } finally {
        privateKeySeed.fill(0);
      }
    });

    await steps.step('export_screen_names_the_account_it_leaves_out', async () => {
      await walletB.navigateTo('/settings/encrypted-wallet-file');
      const unlockStep = walletB.page
        .getByTestId('encrypted-file-manager-flow')
        .getByTestId('encrypted-file-wallet-password');
      const notice = unlockStep.getByTestId('encrypted-file-excluded-accounts');
      await expect(notice).toContainText(`Not in this file: ${GUARDIAN_ACCOUNT_NAME}`, { timeout: 60_000 });
      await expect(notice).not.toContainText(IMPORTED_ACCOUNT_NAME);

      const captureBothThemes = async (size: string) => {
        for (const theme of ['light', 'dark']) {
          await walletB.page.evaluate(
            dark => document.documentElement.classList.toggle('dark', dark),
            theme === 'dark'
          );
          await expect(notice).toBeVisible();
          await walletB.page.screenshot({ path: testInfo.outputPath(`wallet-file-excluded-${size}-${theme}.png`) });
        }
        await walletB.page.evaluate(() => document.documentElement.classList.remove('dark'));
      };
      await captureBothThemes('default');

      // A small phone: the warning must not push the step's unlock control out of reach. On the
      // extension that is the pinned Continue; the passcode pad mounts only in a Capacitor build
      // without hardware protection, which this spec cannot run.
      const defaultViewport = walletB.page.viewportSize();
      await walletB.page.setViewportSize({ width: 360, height: 640 });
      const consent = unlockStep.getByTestId('encrypted-file-wallet-password-consent');
      await consent.scrollIntoViewIfNeeded();
      // Actionability only (visible, stable, not covered): a real click would leave the
      // consent ticked, and the export below clicks it again.
      await consent.click({ trial: true });
      await expect(unlockStep.getByTestId('encrypted-file-wallet-password-submit')).toBeInViewport();
      await captureBothThemes('360x640');
      if (defaultViewport) await walletB.page.setViewportSize(defaultViewport);
    });

    await steps.step('export_writes_the_file', async () => {
      // Waits for "Exported!": before #1114 this wallet stopped at "Export Failed".
      const backupPath = await walletB.exportEncryptedWalletFile({
        walletPassword: WALLET_PASSWORD,
        filePassword: FILE_PASSWORD,
        fileName: 'hot-key-guardian-backup'
      });
      handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-file-1114-'));
      backupCopy = path.join(handoffDir, path.basename(backupPath));
      fs.copyFileSync(backupPath, backupCopy);
    });
  });

  test('restores the file into a fresh wallet with the imported account and no Guardian account (#1114)', async ({
    walletA,
    steps
  }) => {
    expect(backupCopy, 'runs after the export test in this file').not.toBe('');

    await steps.step('restore_into_a_fresh_wallet', async () => {
      // This test's walletA is a new profile, still at the Welcome screen the helper starts from.
      await walletA.restoreEncryptedWalletFile({
        backupPath: backupCopy,
        filePassword: FILE_PASSWORD,
        newWalletPassword: RESTORED_PASSWORD
      });
    });

    await steps.step('imported_account_is_back_and_no_guardian_account_is', async () => {
      expect(await walletA.findAccountByName(IMPORTED_ACCOUNT_NAME)).toBe(importedAccountId);
      expect(await walletA.getAccountAddress()).toBe(importedAccountId);
      expect(await walletA.signAccountWord(importedAccountId, CHALLENGE_WORD)).toMatch(/^0x[0-9a-f]+$/i);

      const accounts = await walletA.page.evaluate(() => {
        type StoreHook = { getState(): { accounts: { publicKey: string; type: string }[] } };
        const store: StoreHook | undefined = Reflect.get(window, '__TEST_STORE__');
        return (store?.getState().accounts ?? []).map(({ publicKey, type }) => ({ publicKey, type }));
      });
      // The file's database still holds the Guardian's SDK row; no account may come of it.
      expect(accounts).toEqual([{ publicKey: importedAccountId, type: 'on-chain' }]);
      expect(accounts.map(account => account.publicKey)).not.toContain(guardianAddress);
    });
  });
});
