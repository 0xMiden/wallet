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
 *  4. The failure surface (#630). A recovery that fails has already wiped the
 *     wallet — the second test READS that, rather than asserting it in prose:
 *     `hasVaultCheckEntry` is true before the reset and false after the failure,
 *     which is the only thing in this file that would go red if `clearStorage()`
 *     were dropped from `Vault.spawn`. Given the wipe, navigating away would
 *     drop the user on an empty wallet with no explanation — indistinguishable
 *     from data loss — so the same test pins that the failure reason is on
 *     screen and says which failure it was.
 */
import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  RECOVERY_ERROR_TESTID,
  expectUnlockRejects,
  hasVaultCheckEntry,
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
    // diagnostic — a fake failure reason. The waits that get pre-empted are the
    // LAST ones, which here are the re-key pair: the one genuinely novel thing
    // this spec proves. Itemised, one attempt per call:
    //
    //   createGuardianWallet          180s (60s confirmation + 120s home)
    //   midenCli.init                 120s (init run + its sync)
    //   createFaucet                  180s   mint 60s   sync 60s
    //   note-discovery pin            120s
    //   claimAllNotes                 132s (120s + ~12s of reload/prepare)
    //   funded-balance pin            120s
    //   lockWallet ×2                  64s (reload + unlock-screen wait)
    //   openForgotPasswordFlow        165s (navigateHome 60s + 7×15s)
    //   submitRecoveryFromSeed        135s (4 bounded clicks + 3 waits)
    //   recovery outcome              120s   completeHotKeyRotation 150s
    //   post-recovery reload + pin    180s
    //   expectUnlockRejects           105s   unlockWallet 105s
    //
    // ≈ 1996s = 33.3 minutes, hence 35. Deliberately NOT included: the CLI
    // helpers' transient-RPC retry ceilings (createFaucet alone is 5×180s +
    // backoff — helpers/miden-cli.ts) and `navigateHome`'s unbounded `page.goto`
    // (wallet-page.ts, shared). No wall-clock budget can cover a full retry
    // storm, and a run in that state has already lost the chain rather than the
    // assertion. Expected real runtime is ~8 minutes, so every individual wait
    // above has room to blow its own ceiling and still print its own diagnostic
    // — which is the entire point of the budget.
    //
    // The honest cost, since an earlier version of this comment cited
    // `maxFailures` as the reason it fits: `maxFailures` bounds the NUMBER of
    // failures, not wall clock, so it does not cap this. A single wedged run of
    // this file can claim 35 of the guardian job's 60 minutes while sitting
    // partway through a long sequential list — and a job timeout loses the
    // artifacts that would explain it. That is the trade being made: a budget
    // shorter than the waits reports a bare "Test timeout" naming no step, which
    // is worse. Sharding the guardian job is the real fix if this bites.
    test.setTimeout(2_100_000);

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

      // Discovery BEFORE claim: claimAllNotes stops on two empty pending reads,
      // which is also true before the note has synced -- claiming too early
      // returns "drained" having consumed nothing, and the vault pin below then
      // fails on a healthy run. Seen for real on main (runs 32070055869 and
      // 32203559789), where this step logged "drained in 2 iteration(s)" with
      // pending=0 and then read vault 0 with the whole mint still unconsumed.
      await waitForPendingNoteTotal(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });

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

      // Reload BEFORE reading the balance, so the reading is provably derived
      // from post-recovery state. `vaultBalance` reads the page's in-memory
      // Zustand `balances` map; nothing in the reset clears it (`syncFromBackend`
      // only merges, and `clearClientStorage()` touches localStorage/
      // sessionStorage only), and this profile held exactly FUND_BASE_UNITS of
      // TST before the wipe — the same number asserted here. Today the store is
      // in fact discarded by the `page.reload()` that happens to live inside
      // `lockWallet()`, but that reload is documented there as a display
      // convenience ("Reload to show the locked state"), so relying on it would
      // make this pin one refactor away from matching the PRE-wipe value on its
      // first poll and passing a recovery that restored nothing.
      await walletA.page.reload({ waitUntil: 'domcontentloaded' });
      await walletA.page.getByTestId('explore-page').waitFor({ timeout: 60_000 });

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

  test('a recovery that fails wipes the wallet and says why, in place', async ({ walletA, steps }) => {
    // `walletA`, not `walletB`: the `walletB` fixture depends on `walletA` AND
    // `midenCli`, so destructuring it would stand up TWO persistent Chrome
    // contexts (each paying a ~14MB WASM service-worker init) plus a CLI workdir
    // to drive one wallet that never touches the chain. This leg only needs a
    // wallet that exists and is locked.
    //
    // Itemised, one attempt per call: createGuardianWallet 180s, lockWallet 32s,
    // openForgotPasswordFlow 165s, submitRecoveryFromSeed 135s, the 120s
    // failure-surface wait, plus the storage reads and text read (sub-second).
    // ≈ 632s = 10.5 minutes, hence 15 — comfortably above, so the
    // failure-surface wait (the one that carries #630) can print its own
    // diagnostic instead of dying on a bare test timeout.
    test.setTimeout(900_000);

    await steps.step('create_and_lock_a_wallet_worth_destroying', async () => {
      await walletA.createGuardianWallet(A, OLD_PASSWORD);
      await walletA.lockWallet();

      // The "before" half of the wipe proof. A live wallet has this entry; if it
      // ever read false the wallet was never really created and the "after" read
      // further down would pass for the wrong reason.
      expect(await hasVaultCheckEntry(walletA.page), 'the wallet being reset must exist before the reset').toBe(true);
    });

    await steps.step(
      'recovery_fails_and_the_flow_stays_put',
      async () => {
        await openForgotPasswordFlow(walletA);
        await submitRecoveryFromSeed(walletA.page, {
          seed: MNEMONIC_WITH_NO_GUARDIAN_ACCOUNT,
          password: NEW_PASSWORD
        });

        const failure = walletA.page.getByTestId(RECOVERY_ERROR_TESTID);

        // This single check carries the whole #630 fix, because the failure text
        // only exists INSIDE `onboarding-confirmation` (Confirmation.tsx): seeing
        // it proves both that a reason was surfaced AND that the flow did not
        // navigate onward, which is what it used to do after console.error'ing
        // the rejection. A separate "confirmation screen is visible" assertion
        // here would be the same fact stated twice (and could not fail, since
        // this locator is a descendant of that container).
        await expect(failure, 'a recovery that failed after wiping the wallet must say so on screen').toBeVisible({
          timeout: 120_000
        });

        // The "after" half. `Vault.spawn` wipes storage at its Step 3, before the
        // guardian lookup at Step 7a that this seed makes throw — so by now the
        // wallet really is gone and this screen is all the user has left. Nothing
        // else in this file would notice if `clearStorage()` were removed:
        // test 1 would still recover the same address and balance, and the
        // reason below would still render.
        expect(
          await hasVaultCheckEntry(walletA.page),
          'the reset is destructive: a recovery that failed must have already wiped the vault'
        ).toBe(false);

        const reason = (await failure.innerText()).trim();
        // Two things had to be fixed for this string to exist.
        //
        // 1. The SW rejects over the intercom port with an `IntercomError`, which
        //    only `implemented` Error — a TS-only contract, erased at compile
        //    time — so every `e instanceof Error ? e.message : String(e)` consumer
        //    (`ForgotPassword.tsx:94` among ~25 others) fell through to
        //    `String(e)` and printed the literal "[object Object]".
        // 2. `Vault.spawn` wraps its body in `withError('Failed to create
        //    wallet', …)`, which replaces any non-PublicError with that generic
        //    string. So even once the object was readable, the one failure a user
        //    can act on — wrong seed, or right seed at the wrong operator — was
        //    console-only. The recovery lookup's own reason is now promoted to a
        //    PublicError so it survives the wrapper.
        //
        // Matching the reason itself, not just "it isn't [object Object]": a
        // negative substring check would also pass on '', 'undefined', and on
        // `DEFAULT_ERROR_MESSAGE` ('Unexpected error occured'), i.e. on every
        // degradation short of a literal stringified object. The text is
        // `miden-client-interface.ts`'s own, thrown when the HD scan hits
        // RECOVERY_GAP_LIMIT with nothing found — exactly what this mnemonic
        // produces. A different message here means a different failure happened
        // and the test is not testing what it claims.
        expect(
          reason,
          'after an irreversible wipe the screen must name the failure — this text is all the user gets'
        ).toContain('No Guardian accounts found');
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );
  });
});
