import { expect, test } from '../fixtures/two-wallets';
import { fromBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  LOCKOUT_MS,
  WRONG_PASSWORDS_TO_LOCKOUT,
  expectLockedOut,
  expectNotLockedOut,
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
 *   2. The escalating lockout RENDERS against that real vault, and only on the
 *      THIRD wrong password: the field is asserted still usable, instantly, after
 *      each of the first two (`expectNotLockedOut`).
 *   3. The lockout runs its documented term and clears BY ITSELF, with no user
 *      action. The countdown is asserted to open inside the first tier and to
 *      tick down, and the hold is measured from the timelock the product itself
 *      stamped — so neither a shortened LOCK_TIME nor a frozen timer passes.
 *   4. THE KEY ASSERTION — after the successful unlock, the funded vault
 *      balance is EXACTLY what it was before the lock.
 *
 * (4) is what distinguishes this from a screen-transition test. `fetchAccounts`
 * decrypts the accounts blob with the in-memory vault key (vault.ts), so the
 * account address the balances projection is keyed on is only recoverable after
 * a successful PBKDF2 re-derive. Reading the same exact TST total afterwards
 * therefore proves the key was genuinely re-derived and the SAME account
 * restored — not merely that a screen changed.
 *
 * That reading cannot be a stale number that was never cleared: the store has no
 * persist middleware (`create()(subscribeWithSelector(...))`, src/lib/store/index.ts)
 * and initialises `balances: {}`, and BOTH `lockWallet()` and the extension's
 * unlock path go through a full page reload. The projection the final assertion
 * polls is therefore rebuilt from empty, by a SyncCompleted broadcast that only
 * a re-derived key can produce.
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
    // The outer budget must EXCEED the sum of the sub-budgets underneath it, or a
    // slow-but-working run dies on the outer timeout and Playwright blames
    // whatever step happened to be running — indistinguishable from the vault
    // regression this spec exists to detect. The explicit budgets below sum to:
    //
    //   note discovery                       120s
    //   claim                                120s
    //   vault settles after the claim         60s
    //   unlock screen renders                 30s
    //   3 wrong passwords          3 x  41s = 123s  (submitWrongPassword)
    //   lockout renders + one tick            36s  (expectLockedOut)
    //   lockout expires                       90s
    //   correct password reaches home         45s  (unlockWallet)
    //   vault rebuilt after the unlock       120s
    //                                       -----
    //                                        744s
    //
    // The remainder covers wallet creation and the CLI faucet deploy/mint, which
    // carry no explicit budget of their own.
    test.setTimeout(900_000);

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
      //
      // This wait IS the assertion that the claim credited the vault exactly:
      // it returns only on equality with MINT_BASE_UNITS and throws with both
      // readings otherwise. Re-reading the same value into an `expect` below
      // would add no discriminating power, only a window for a concurrent
      // AutoSync to make a WORKING wallet fail.
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 60_000,
        decimals: TOKEN_DECIMALS
      });

      // The baseline is MINT_BASE_UNITS itself, NOT a fresh read of it. The wait
      // above already proved the vault equals that figure; re-reading introduces
      // the one hole this spec cannot afford — if AutoSync moved the number
      // between the two reads, the post-unlock comparison below would be made
      // against a corrupted baseline and could agree with a wallet that came
      // back wrong.
      fundedBaseUnits = MINT_BASE_UNITS;
    });

    await steps.step(
      'lock_wallet',
      async () => {
        await walletA.lockWallet();
        await expect(walletA.page.getByTestId('unlock-password')).toBeVisible({ timeout: 30_000 });
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
        if (i < WRONG_PASSWORDS_TO_LOCKOUT) {
          // Three, not two. This is an instantaneous read, deliberately not a
          // wait: every other check tolerates a disabled field by sitting on it
          // until it clears, so without this an unlock screen that locked out
          // after ONE wrong password would sail through the rest of the spec.
          await expectNotLockedOut(walletA.page, i);
        }
      }
    });

    await steps.step(
      'lockout_renders',
      async () => {
        await expectLockedOut(walletA.page);
        timeline.emit({
          category: 'ui_assertion',
          severity: 'info',
          wallet: 'A',
          message:
            `Lockout rendered after ${WRONG_PASSWORDS_TO_LOCKOUT} wrong passwords (and not before): ` +
            `password field disabled with a countdown ticking down inside the ${LOCKOUT_MS}ms tier`,
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
      // the timelock is cleared by Unlock.tsx's own 1s interval. `heldMs` is
      // measured from the timelock the product stamped, so it is the lockout's
      // real duration and not "however long the harness happened to wait".
      const heldMs = await waitForLockoutToExpire(walletA.page, { timeoutMs: 90_000 });
      timeline.emit({
        category: 'ui_assertion',
        severity: 'info',
        wallet: 'A',
        message: `Lockout held for ${heldMs}ms (LOCK_TIME is ${LOCKOUT_MS}ms) and expired with no user action`,
        data: { heldMs, lockTimeMs: LOCKOUT_MS }
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
        // THE KEY ASSERTION, and the wait IS the assertion: it returns only when
        // the vault reads exactly the pre-lock total and throws with both
        // readings otherwise. Polled rather than read once because the extension
        // rebuilds the balances projection from a SyncCompleted broadcast after
        // the unlock's reload, so a bare read here samples an empty store — the
        // empty start being precisely what makes the eventual match meaningful.
        await waitForVaultBalance(walletA.page, TOKEN, fundedBaseUnits!, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          wallet: 'A',
          message:
            `Vault key re-derived: ${fromBaseUnits(fundedBaseUnits!, TOKEN_DECIMALS)} ${TOKEN} restored exactly, ` +
            `rebuilt from an empty store after the unlock's reload`,
          data: {
            symbol: TOKEN,
            beforeLockBaseUnits: fundedBaseUnits!.toString(),
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
