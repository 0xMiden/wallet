import { AuthSecretKey } from '@miden-sdk/miden-sdk';
import { type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { PASSWORD } from '../helpers/wallet-page';

// Primary guardian operator for the selected network (E2E_NETWORK).
const A = getEnvironmentConfig().guardianUrl;
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
 * the Guardian account the file does not restore before the user consents, and the file restores
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

  test('exports its imported account and names the account it does not restore (#1114)', async ({
    walletA,
    walletB,
    steps
  }, testInfo) => {
    test.setTimeout(480_000);

    const captureBothThemes = async (page: Page, target: Locator, size: string) => {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await expect(target).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`wallet-file-excluded-${size}-${theme}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };

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

    await steps.step('export_screen_names_the_account_it_does_not_restore', async () => {
      await walletB.navigateTo('/settings/encrypted-wallet-file');
      const unlockStep = walletB.page
        .getByTestId('encrypted-file-manager-flow')
        .getByTestId('encrypted-file-wallet-password');
      const notice = unlockStep.getByTestId('encrypted-file-excluded-accounts');
      await expect(notice).toContainText(`Not restored from this file: ${GUARDIAN_ACCOUNT_NAME}`);
      await expect(notice).not.toContainText(IMPORTED_ACCOUNT_NAME);

      await captureBothThemes(walletB.page, notice, 'default');

      // popup.html closes any tab that is not a real action-popup view (src/popup.tsx: absent
      // that, it calls openInFullPage() and window.close()). Report this tab as that view before
      // any script runs, and give it the action popup's fixed size: this flow never opens full
      // page (isPopupModeEnabled defaults true, nothing here calls openInFullPage), so the popup
      // is what a user actually sees, not fullpage.html's 640px-minimum shell.
      const popupPage = await walletB.page.context().newPage();
      try {
        await popupPage.addInitScript(() => {
          const getViews = chrome.extension.getViews.bind(chrome.extension);
          chrome.extension.getViews = fetchProperties =>
            fetchProperties?.type === 'popup' ? [window] : getViews(fetchProperties);
        });
        await popupPage.setViewportSize({ width: 360, height: 600 });
        await popupPage.goto(`chrome-extension://${walletB.extensionId}/popup.html#/settings/encrypted-wallet-file`, {
          waitUntil: 'domcontentloaded'
        });

        const popupUnlockStep = popupPage
          .getByTestId('encrypted-file-manager-flow')
          .getByTestId('encrypted-file-wallet-password');
        const popupNotice = popupUnlockStep.getByTestId('encrypted-file-excluded-accounts');
        await expect(popupNotice).toContainText(`Not restored from this file: ${GUARDIAN_ACCOUNT_NAME}`);

        // The real popup shell has no fullpage.html-style min-width: assert it actually fits
        // 360px rather than trusting the viewport size alone.
        expect(await popupPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

        const consent = popupUnlockStep.getByTestId('encrypted-file-wallet-password-consent');
        const submit = popupUnlockStep.getByTestId('encrypted-file-wallet-password-submit');
        for (const target of [popupNotice, consent, submit]) {
          const box = await target.boundingBox();
          if (!box) throw new Error('popup layout assertion: element has no bounding box');
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(360);
        }

        // Continue is pinned by SubPageLayout's FlowFooter, so it is always in viewport; the
        // consent row is what a longer notice pushes below the fold.
        await expect(popupNotice).toBeInViewport({ ratio: 1 });
        await expect(consent).toBeInViewport({ ratio: 1 });

        await captureBothThemes(popupPage, popupNotice, 'popup');
      } finally {
        await popupPage.close();
      }
    });

    await steps.step('export_writes_the_file', async () => {
      // Waits for "Exported!": before #1114 this wallet stopped at "Export Failed".
      const backupPath = await walletB.exportEncryptedWalletFile({
        walletPassword: PASSWORD,
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
    test.setTimeout(480_000);
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
    });
  });
});
