import { expect, test } from '../fixtures/two-wallets';
import { fromBaseUnits, vaultBalance, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  LOCKOUT_MS,
  WRONG_PASSWORDS_TO_LOCKOUT,
  expectLockedOut,
  submitWrongPassword,
  waitForLockoutToExpire
} from '../helpers/unlock-lockout';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to wallet A, in base units (= 1000 TST). Claimed in full before the
// lock, so the whole amount is SPENDABLE VAULT balance, not a pending note —
// which is what makes "the balance survived" a statement about the vault key.
const MINT_AMOUNT = 100_000_000_000;
const MINT_BASE_UNITS = BigInt(MINT_AMOUNT);

/**
 * The unlock screen runs more often than any other in the extension: the vault
 * key lives only in service-worker memory (`private vaultKey: CryptoKey` in
 * src/lib/miden/back/vault.ts), so it is gone the moment the worker is, and the
 * user is back here. This spec covers the REJECTION path through it, which no
 * Chrome spec has ever driven — wallet-lifecycle.spec.ts only does the happy
 * lock -> unlock -> home transition, and jest's Unlock.test.tsx covers the
 * counter arithmetic with `unlock` mocked out and localStorage pre-seeded.
 *
 * What is genuinely new here, and why each part earns its wall clock:
 *
 *   1. A wrong password is REJECTED by the real crypto path — a full PBKDF2
 *      derive against the real vault, not a mock. Nothing else in the suite
 *      types one.
 *   2. The escalating lockout RENDERS against that real vault: three wrong
 *      passwords disable the field for LOCK_TIME (src/app/pages/Unlock.tsx).
 *   3. The lockout clears BY ITSELF, with no user action, after its full term.
 *   4. THE KEY ASSERTION — after the successful unlock, the funded vault
 *      balance is EXACTLY what it was before the lock.
 *
 * (4) is what distinguishes this from a screen-transition test. `fetchAccounts`
 * decrypts the accounts blob with the in-memory vault key (vault.ts), so the
 * account address the balances projection is keyed on is only recoverable after
 * a successful PBKDF2 re-derive. Reading the same exact TST total afterwards
 * therefore proves the key was genuinely re-derived and the SAME account
 * restored — not merely that a screen changed. The zero reading taken while
 * locked is what makes that falsifiable: it rules out the post-unlock number
 * being a stale value that was never cleared in the first place.
 *
 * SCOPE: this drives an explicit intercom LOCK_REQUEST, which is the lock the
 * harness can trigger deterministically. It does NOT cover service-worker
 * eviction; that is a different mechanism (ChromeWalletPage.kill()/reopen())
 * and would not survive being combined with a 60-second lockout in one spec.
 */
test.describe('Unlock — wrong password, lockout escalation, and balance continuity', () => {
  test.describe.configure({ mode: 'serial' });

  test('a funded vault survives three wrong passwords, the lockout, and a real re-unlock', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    // Budget: mint + note discovery (120s) + claim (120s) are the same costs
    // every funding spec pays, and this spec adds a hard, irreducible LOCK_TIME
    // of 60s plus four full PBKDF2 derives (three rejections and one success, at
    // ~10.3M iterations each). The default 300s cannot hold that on a loaded
    // runner, and would fail for reasons unrelated to what is under test.
    test.setTimeout(480_000);

    let addressA: string;
    // The exact pre-lock reading the final assertion compares against. Captured
    // from the store rather than assumed from MINT_BASE_UNITS, so the comparison
    // is "identical to what this wallet actually held", not "matches a constant".
    let fundedBaseUnits: bigint;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      addressA = a.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, MINT_AMOUNT, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        // The mint creates a NOTE, so its value is UNCONSUMED until the claim
        // below — it is not spendable yet, and asserting the vault here would
        // be asserting the wrong quantity.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step('claim_notes_and_record_funded_balance', async () => {
      await walletA.claimAllNotes(120_000);
      // claimAllNotes returns once the PENDING list reads empty twice; it does
      // not wait for the store's balances projection to catch up. The whole
      // point of this spec is a before/after vault comparison, so the "before"
      // has to be a settled reading.
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });

      fundedBaseUnits = await vaultBalance(walletA.page, TOKEN);
      expect(fundedBaseUnits).toBe(MINT_BASE_UNITS);
    });

    await steps.step(
      'lock_wallet',
      async () => {
        await walletA.lockWallet();
        await expect(walletA.page.getByTestId('unlock-password')).toBeVisible({ timeout: 30_000 });

        // With the vault key gone, the balances projection must be gone with it.
        // Without this reading the final assertion would be satisfiable by a
        // number that simply never cleared, which would prove nothing about the
        // key having been re-derived.
        const whileLocked = await vaultBalance(walletA.page, TOKEN);
        expect(whileLocked).toBe(0n);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('reject_three_wrong_passwords', async () => {
      // Distinct values per attempt on purpose: `onPasswordChange` clears the
      // error on every keystroke, so a different password gives two separately
      // observable renders per attempt (previous error cleared, new one shown).
      // Re-typing one value would leave the previous rejection on screen and let
      // an attempt that never submitted read as an attempt that was rejected.
      for (let i = 1; i <= WRONG_PASSWORDS_TO_LOCKOUT; i++) {
        await submitWrongPassword(walletA.page, `NotThePassword${i}!`);
      }
    });

    await steps.step(
      'lockout_renders',
      async () => {
        // Three, not two: after the second failure `timelock` is still 0, so
        // `Date.now() - 0 <= 60_000` is false and the form stays usable. This is
        // the first submit that arms the timelock.
        await expectLockedOut(walletA.page);
        timeline.emit({
          category: 'ui_assertion',
          severity: 'info',
          wallet: 'A',
          message: `Lockout rendered after ${WRONG_PASSWORDS_TO_LOCKOUT} wrong passwords: password field disabled with a countdown`,
          data: { wrongAttempts: WRONG_PASSWORDS_TO_LOCKOUT, lockTimeMs: LOCKOUT_MS }
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('lockout_clears_without_user_action', async () => {
      // Explicit and bounded, and deliberately NOT left to `unlockWallet()`:
      // `fill()` auto-waits for the field to be enabled with no action timeout
      // configured, so folding this wait into the unlock would spend the same
      // 60 seconds and assert nothing at all about the lockout.
      //
      // Nothing is touched between the lockout rendering and this returning —
      // the timelock is cleared by Unlock.tsx's own 1s interval.
      const waitedMs = await waitForLockoutToExpire(walletA.page, { timeoutMs: 90_000 });
      timeline.emit({
        category: 'ui_assertion',
        severity: 'info',
        wallet: 'A',
        message: `Lockout expired on its own after ${waitedMs}ms with no user action`,
        data: { waitedMs, lockTimeMs: LOCKOUT_MS }
      });
    });

    await steps.step('unlock_with_the_correct_password', async () => {
      // Reaching the home surface is itself the proof that this password
      // decrypted the vault key — `unlockWallet` throws if `explore-page` never
      // renders. wallet-lifecycle.spec.ts already covers that transition on its
      // own; here it is the precondition for the assertion that follows.
      await walletA.unlockWallet();
    });

    await steps.step(
      'funded_balance_survived_the_lock',
      async () => {
        // THE KEY ASSERTION. Polled, not read once: on the extension the
        // balances projection is rebuilt from a SyncCompleted broadcast after
        // the unlock's reload, so a bare read here samples an empty store.
        await waitForVaultBalance(walletA.page, TOKEN, fundedBaseUnits!, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        const afterUnlock = await vaultBalance(walletA.page, TOKEN);
        expect(afterUnlock).toBe(fundedBaseUnits!);

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          wallet: 'A',
          message:
            `Vault key re-derived: ${fromBaseUnits(afterUnlock, TOKEN_DECIMALS)} ${TOKEN} restored exactly, ` +
            `after reading 0 while locked`,
          data: {
            symbol: TOKEN,
            beforeLockBaseUnits: fundedBaseUnits!.toString(),
            afterUnlockBaseUnits: afterUnlock.toString(),
            wrongAttempts: WRONG_PASSWORDS_TO_LOCKOUT
          }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
