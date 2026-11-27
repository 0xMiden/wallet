import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/multi-device';
import {
  answerRecoveryPhraseKeepPrompt,
  expectNoFailedRows,
  expectNoRecoveryPhraseKeepPrompt,
  readCurrentAccount,
  readRecoveryPhraseStatus,
  recoverToDeviceRoleStep,
  waitForRecoveryPhraseKeepPrompt,
  waitForSignerCount
} from '../../helpers/multi-device';
import {
  createFundedGuardianAccount,
  KEEP_PROMPT_SHEET,
  pressDeviceRoleContinue,
  readKeepPromptArmedFor,
  selectDeviceRole,
  waitForRotationGateCleared
} from '../../helpers/multi-device-roles';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';

/**
 * Recover `wallet` with the recovery phrase, answer "Add this device" by hand
 * (so no Keep handler is installed), and wait until the add lands. The keep
 * sheet must not show while the rotation gate is up. Returns with the sheet
 * still unanswered.
 */
async function joinWithAddAndLeaveThePrompt(
  wallet: GuardianAwareWalletPage,
  phrase: string,
  address: string
): Promise<void> {
  wallet.trackGuardianCommitments();
  await recoverToDeviceRoleStep(wallet, phrase);
  expect(await wallet.getAccountAddress(), 'the recovery phrase restores the same account').toBe(address);
  await selectDeviceRole(wallet, 'add');
  await pressDeviceRoleContinue(wallet);
  // Continue arms the prompt for this account (`armRecoveryPhraseKeepPrompt`).
  await expect
    .poll(() => readKeepPromptArmedFor(wallet), { message: 'Continue armed the keep prompt', timeout: 30_000 })
    .toBe(address);
  await waitForRotationGateCleared(wallet, {
    timeoutMs: 300_000,
    failOnRoleStep: true,
    forbiddenWhileGateUp: [KEEP_PROMPT_SHEET]
  });
}

/** The sheet shows only for an account that holds its everyday key and needs no rotation. */
async function expectRotationDone(wallet: GuardianAwareWalletPage): Promise<void> {
  const account = await readCurrentAccount(wallet.page);
  expect(account?.requiresHotKeyRotation, 'no rotation is pending when the sheet shows').not.toBe(true);
  expect(typeof account?.hotPublicKey, 'the account holds its everyday key when the sheet shows').toBe('string');
}

/**
 * The "Keep your recovery phrase?" sheet (`RecoveryPhraseKeepPrompt.tsx`) after
 * a recovery with "Add this device".
 *
 * Device A creates the account. Device B joins and answers Remove: the
 * recovery phrase is gone from B at once. Device C joins and answers Keep: the
 * phrase stays on C. On both, Continue on the role step arms the sheet, and
 * the sheet shows only after the add landed (never while the rotation gate is
 * up). After C reopens, the sheet does not show again: Keep cleared its arming
 * key, and the sheet reads that key.
 *
 * Both joiners recover with the real screens and answer the role step by hand,
 * which is the `recoveryPhrasePrompt: 'leave'` policy: no Keep handler is ever
 * installed on B or C.
 */
test.describe('Multi-device roles: recovery phrase keep sheet', () => {
  test('Remove removes the phrase, Keep keeps it, and the sheet shows once and only after the add', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    envConfig
  }) => {
    let address = '';
    let phrase = '';

    await steps.step('create_and_fund_on_a', async () => {
      const account = await createFundedGuardianAccount(walletA, midenCli, envConfig.guardianUrl);
      address = account.address;
      phrase = account.phrase;
    });

    await steps.step('b_joins_with_add', async () => {
      await joinWithAddAndLeaveThePrompt(walletB, phrase, address);
    });

    await steps.step('b_answers_remove', async () => {
      await waitForRecoveryPhraseKeepPrompt(walletB);
      await expectRotationDone(walletB);
      expect(await readRecoveryPhraseStatus(walletB), 'the phrase is stored when the sheet asks').toBe('stored');
      await answerRecoveryPhraseKeepPrompt(walletB, 'remove');
      await expect
        .poll(() => readRecoveryPhraseStatus(walletB), { message: 'Remove removes the phrase', timeout: 60_000 })
        .toBe('removed');
      expect(await readKeepPromptArmedFor(walletB), 'the answer clears the arming key').toBe('');
      await dismissTelemetryConsent(walletB.page);
      // C's add must not meet B's add as a pending candidate.
      await walletB.waitForGuardianSettled();
    });

    await steps.step('c_joins_with_add', async () => {
      await joinWithAddAndLeaveThePrompt(walletC, phrase, address);
    });

    await steps.step('c_answers_keep', async () => {
      await waitForRecoveryPhraseKeepPrompt(walletC);
      await expectRotationDone(walletC);
      await answerRecoveryPhraseKeepPrompt(walletC, 'keep');
      expect(await readRecoveryPhraseStatus(walletC), 'Keep keeps the phrase').toBe('stored');
      expect(await readKeepPromptArmedFor(walletC), 'the answer clears the arming key').toBe('');
      await dismissTelemetryConsent(walletC.page);
      await walletC.waitForGuardianSettled();
    });

    await steps.step('c_reopens_without_the_sheet', async () => {
      await walletC.reopen();
      // Wait until the store holds every input the sheet reads, so its absence is a real answer.
      await expect
        .poll(
          async () => {
            const account = await readCurrentAccount(walletC.page);
            return typeof account?.hotPublicKey === 'string' && (await readRecoveryPhraseStatus(walletC)) === 'stored';
          },
          { message: 'C loaded its account and its phrase status', timeout: 60_000 }
        )
        .toBe(true);
      expect(await readKeepPromptArmedFor(walletC), 'nothing arms the sheet after the reopen').toBe('');
      await expectNoRecoveryPhraseKeepPrompt(walletC);
    });

    await steps.step('chain_holds_four_signers', async () => {
      // Two adds: A's hot key, B's, C's and the cold key.
      await waitForSignerCount(walletC, address, 4);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
      await expectNoFailedRows(walletC);
    });
  });
});
