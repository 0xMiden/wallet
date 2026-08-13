/**
 * "I forgot my password."
 *
 * The only destructive route in the wallet: `Unlock` → `#forgot-password` →
 * `/forgot-password-info` → Sign Out → `/forgot-password`, where
 * `ForgotPassword.tsx` wipes the local wallet (`Vault.spawn`'s `clearStorage()`
 * of `chrome.storage.local`, where the vault key lives) and re-registers the
 * account from the seed the user just typed, under a brand-new password. Before
 * this file, ZERO specs referenced forgot-password or reset-wallet — the whole
 * route was E2E-dark, and the only thing standing behind it is a wipe that
 * cannot be undone.
 *
 * WHAT IS *NOT* NEW HERE, AND MUST NOT BE RE-PROVEN
 *
 * `guardian-recovery.spec.ts` already covers seed recovery on the OTHER route:
 * its `addressB === addressA` pin (:145-155) proves the derivation, and its
 * `waitForVaultBalance(walletB, TOKEN, FUND_BASE_UNITS)` (:157-171) proves the
 * funded balance reappears. `guardian-seed-backup-verify.spec.ts` (:161-176)
 * pins the same-address invariant a third time. This spec re-checks address and
 * balance for exactly one reason, stated so it can be judged: those specs
 * recover onto a CLEAN, never-onboarded second profile with a fresh service
 * worker, whereas this route recovers IN PLACE — same browser profile, same
 * long-lived service worker, over storage that was populated and is wiped
 * mid-flight. "Derives the same id from the same seed" and "survives having its
 * own storage torn out from under a running SW" are different failures.
 *
 * Likewise NOT re-tested here: seed-entry validation (guardian-recovery.spec.ts
 * :239-286 already probes the very same `ImportSeedPhrase` screen this flow
 * renders), and a post-recovery SEND (`helpers/money-path.ts` on the guardian
 * axis already proves a guardian account spends, and guardian-recovery proves a
 * rotated signer set moves money — a send here would be ~80% duplicate for
 * several minutes of a 60-minute job budget).
 *
 * WHAT IS GENUINELY NEW
 *
 *  1. The entry route itself, from a locked wallet, including the interstitial
 *     that warns the reset needs the seed phrase (helpers/forgot-password.ts).
 *  2. Recovery IN PLACE over populated storage: same address, same exact vault
 *     balance, same profile.
 *  3. The re-key. Nothing anywhere in this repo pins that the wallet comes back
 *     under a DIFFERENT password: `wallet-lifecycle.spec.ts` :31-43 locks and
 *     unlocks with the same one. The falsifiable pair is P2 reaching
 *     `explore-page` and P1 being refused — together they are the only proof the
 *     vault was genuinely re-encrypted rather than reused.
 *  4. The failure surface (#630). A recovery that fails has ALREADY wiped the
 *     wallet, so navigating away would drop the user on an empty wallet with no
 *     explanation — indistinguishable from data loss. The second test drives a
 *     deterministic failure and pins that the user is left on the confirmation
 *     screen, with a readable reason and a Retry button.
 */
import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { waitForVaultBalance } from '../helpers/balance-truth';
import {
  RECOVERY_ERROR_TESTID,
  expectUnlockRejects,
  openForgotPasswordFlow,
  recoverViaForgotPassword,
  submitRecoveryFromSeed
} from '../helpers/forgot-password';

/** Primary guardian operator for the selected network (E2E_NETWORK). */
const A = getEnvironmentConfig().guardianUrl;

/** The faucet the harness deploys (helpers/miden-cli.ts `createFaucet` defaults). */
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
/** Claimed into the vault BEFORE the wipe; must reappear, to the base unit, after it. */
const FUND_BASE_UNITS = 100_000_000_000n;

/**
 * The password the wallet is created with — `createGuardianWallet`'s default,
 * i.e. the one the whole suite uses. It must stop working after the reset.
 */
const OLD_PASSWORD = 'Test1234!';
/**
 * The password typed into the reset flow. Different from OLD_PASSWORD and still
 * satisfying `CreatePassword.tsx`'s real strength gate (>1 of {8+ chars, mixed
 * case, letters+digits, special char, 12+ chars}), since this journey drives
 * that real screen rather than the onboarding bypass.
 */
const NEW_PASSWORD = 'Recovered9#Pass';

/**
 * Canonical BIP-39 test vector (11× "abandon" + "about") — checksum-valid, so
 * `ImportSeedPhrase` accepts it and the flow proceeds all the way into the
 * destructive registration, but it owns no Guardian account at any operator.
 * `MidenClientInterface.recoverGuardianAccountsBySeed` therefore finds nothing
 * for HD indices 0..2, hits `RECOVERY_GAP_LIMIT`, and throws — a real failure
 * with no fault injection, no network manipulation and no faucet.
 */
const MNEMONIC_WITH_NO_GUARDIAN_ACCOUNT =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test.describe('Forgot password — destructive in-place reset', () => {
  test('recovering in place restores the same funded account under a new password', async ({
    walletA,
    midenCli,
    steps
  }) => {
    // The budget must exceed the SUM of this test's own waits, or a wait that
    // blows its deadline reports a bare "Test timeout" instead of its own
    // diagnostic — a fake failure reason. Summed at their maxima: guardian
    // create 190s, CLI init/faucet/mint/sync ~120s, claim 120s, funded-balance
    // pin 120s, entry route ~60s, seed/password/confirmation ~60s, recovery
    // outcome 120s, rotation gate 150s, post-recovery balance pin 120s, and
    // ~105s of lock → reject-old → unlock-new. ≈ 19.5 minutes, hence 20.
    // Expected real runtime is ~8 minutes; this is the ceiling, not the cost.
    test.setTimeout(1_200_000);

    let addressBeforeReset: string;
    let seed = '';
    let faucetId: string;

    await steps.step('create_and_fund_the_wallet_we_are_about_to_wipe', async () => {
      const created = await walletA.createGuardianWallet(A, OLD_PASSWORD);
      addressBeforeReset = created.address;
      seed = created.seedPhrase.join(' ');
      expect(
        created.seedPhrase.length,
        'the reset flow can only be driven with the real 12-word mnemonic this account was created from'
      ).toBe(12);

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressBeforeReset, FUND_BASE_UNITS, 'public');
      await midenCli.sync();
      await walletA.claimAllNotes(120_000);

      // Pin the EXACT spendable balance in setup, so a claim that silently
      // no-oped fails here rather than masquerading later as a recovery that
      // lost money. Fees are paid in native MIDEN, not TST, so the note lands
      // in full.
      await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'reset_in_place_from_the_locked_unlock_screen',
      async () => {
        await walletA.lockWallet();

        // Drives the real route: `#forgot-password` on the locked Unlock screen →
        // the interstitial (whose seed-phrase warning the helper asserts) → Sign
        // Out → seed grid → NEW password → "Open wallet" → the device-key
        // rotation gate, to its cleared state. A failed recovery throws here
        // carrying the on-screen reason instead of timing out on the gate.
        await recoverViaForgotPassword(walletA, { seed, newPassword: NEW_PASSWORD });
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('same_account_and_the_same_money_came_back', async () => {
      const addressAfterReset = await walletA.getAccountAddress();
      // Not a re-run of guardian-recovery.spec.ts:145-155: that proves the seed
      // derives a stable id on a CLEAN profile. This one is about the wipe —
      // `Vault.spawn` cleared `chrome.storage.local` out from under a service
      // worker that was already serving this account, and the account that comes
      // back must still be the same one, not a newly created sibling.
      expect(
        addressAfterReset,
        'the reset must recover the SAME account in place, not create a new one on top of the wiped profile'
      ).toBe(addressBeforeReset!);

      // And it must come back with the money. `> 0` would pass on a wallet that
      // recovered a fraction of its notes; the exact base-unit pin is what makes
      // a partial recovery a failure.
      await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('the_vault_is_re_keyed_to_the_new_password', async () => {
      await walletA.lockWallet();

      // The old password FIRST, and exactly once: `Unlock.tsx` time-locks the
      // form for 60s on the third consecutive failure, so a second wrong attempt
      // would jeopardise the unlock below. This is the assertion that makes the
      // pair meaningful — without it, "the new password works" is also satisfied
      // by a flow that ignored the password field entirely.
      await expectUnlockRejects(walletA, OLD_PASSWORD);

      // …and the password the user actually typed during the reset does open it.
      // `unlockWallet` waits for `explore-page`, so reaching this line means the
      // re-keyed vault decrypted and the wallet is usable again.
      await walletA.unlockWallet(NEW_PASSWORD);
    });
  });

  test('a recovery that fails leaves the user on the confirmation screen with a reason', async ({ walletB, steps }) => {
    // No faucet, no mint, no claim: this leg only needs a wallet that exists and
    // is locked, which keeps it cheap enough to add to an already 42-minute job.
    // Waits at their maxima: guardian create 190s, entry route ~60s, seed/
    // password/confirmation ~60s, the 120s failure-surface wait, and ~65s of
    // tail assertions ≈ 8.3 minutes, hence 10.
    test.setTimeout(600_000);

    await steps.step('create_and_lock_a_wallet_worth_destroying', async () => {
      await walletB.createGuardianWallet(A, OLD_PASSWORD);
      await walletB.lockWallet();
    });

    await steps.step(
      'recovery_fails_and_the_flow_stays_put',
      async () => {
        await openForgotPasswordFlow(walletB);
        await submitRecoveryFromSeed(walletB.page, {
          seed: MNEMONIC_WITH_NO_GUARDIAN_ACCOUNT,
          password: NEW_PASSWORD
        });

        const failure = walletB.page.getByTestId(RECOVERY_ERROR_TESTID);

        // By the time this resolves the wallet is ALREADY gone — `Vault.spawn`
        // wipes storage before it attempts the guardian lookup that throws. The
        // user's only remaining information is this screen.
        //
        // This single check carries the whole #630 fix, because the failure text
        // only exists INSIDE `onboarding-confirmation` (Confirmation.tsx): seeing
        // it proves both that a reason was surfaced AND that the flow did not
        // navigate onward, which is what it used to do after console.error'ing
        // the rejection. A separate "confirmation screen is visible" assertion
        // here would be the same fact stated twice.
        await expect(failure, 'a recovery that failed after wiping the wallet must say so on screen').toBeVisible({
          timeout: 120_000
        });

        const reason = (await failure.innerText()).trim();
        // The reason has to survive the service-worker → page hop to be worth
        // rendering, and until this change it did not: the SW rejects with an
        // `IntercomError`, which only `implemented` Error (a TS-only contract,
        // erased at compile time) rather than extending it, so every
        // `e instanceof Error ? e.message : String(e)` consumer —
        // `ForgotPassword.tsx:94` among ~25 others — fell through to `String(e)`
        // and printed the literal "[object Object]" to a user whose wallet had
        // just been destroyed. `IntercomError` is a real `Error` subclass now.
        //
        // Limit of this check: it pins that a real message crossed the intercom
        // boundary and reached the screen. The wording itself is the backend's
        // (`PublicError('Failed to create wallet')` from `Vault.spawn`'s
        // `withError` wrapper), so it is deliberately not matched literally.
        expect(
          reason,
          'the failure reason must be a readable message, not a stringified object — this is all the user gets after an irreversible wipe'
        ).not.toContain('[object');

        // The primary button must offer another go rather than "Open wallet",
        // which would send the user into the empty wallet the flow just refused
        // to navigate to.
        await expect(
          walletB.page.getByTestId('onboarding-confirmation-submit'),
          'the confirmation button must offer Retry after a failed recovery'
        ).toHaveText('Retry');

        // Re-checked LAST, and only for the "still": everything above ran within
        // a second or two of the failure rendering, so this catches a flow that
        // surfaces the reason and then navigates away a beat later — the exact
        // regression shape #630 fixed, and the only reading of the confirmation
        // screen that the assertions above do not already imply.
        await expect(
          walletB.page.getByTestId('onboarding-confirmation'),
          'the flow must still be on the confirmation screen, not on the wallet it has already wiped'
        ).toBeVisible({ timeout: 5_000 });
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );
  });
});
