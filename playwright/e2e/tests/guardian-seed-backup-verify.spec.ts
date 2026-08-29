import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';

// The guardian this spec creates against — same source guardian-recovery uses.
const GUARDIAN_URL = getEnvironmentConfig().guardianUrl;

/**
 * "The seed phrase I am shown is the one that actually restores my wallet."
 *
 * The highest-consequence invariant in the product: if the twelve words the
 * wallet displays are not the words that reconstruct the account, the user is
 * guaranteed to lose access and will not find out until it is too late. A
 * verify screen that accepts the words proves nothing on its own — it only
 * compares the shown phrase against itself. So this spec closes the loop in a
 * SECOND wallet instance: restore from the captured words and assert it lands
 * on the SAME account address.
 *
 * WHERE THE PRODUCT ACTUALLY SHOWS THE PHRASE (verified in src, 2026-08):
 * NOT during onboarding. `src/app/pages/Welcome.tsx`'s hash router has no
 * `#backup-seed-phrase` / `#verify-seed-phrase` case, so the
 * `BackUpSeedPhraseScreen` / `VerifySeedPhraseScreen` steps wired into
 * `screens/onboarding/navigator.tsx` are never rendered by the create flow
 * (the only other host, `ForgotPassword.tsx`, reaches them from a
 * `create-wallet` action that nothing dispatches). The create flow instead
 * seeds a post-onboarding prompt — `register()` calls
 * `seedWalletPrompt(WalletPromptType.VerifySeedPhrase)` — whose card on the
 * home screen links to `/settings/verify-seed-phrase`
 * (`WALLET_PROMPT_DEFINITIONS` in `app/templates/HomePrompts.tsx`). That route
 * is `app/templates/VerifySeedPhraseFlow.tsx`: warning → password → the twelve
 * words → the first/last-word challenge. It is the ONLY surface a real user
 * can read their recovery phrase from, so it is what this spec drives.
 *
 * WHAT IS AND IS NOT REAL UI HERE:
 *   - Real UI: revealing the phrase (password auth included), the challenge,
 *     and its accept/reject behaviour.
 *   - Harness shortcut: creating wallet A and restoring into wallet B, both via
 *     the `__test_skip_onboarding` bypass. This is forced by the product, not
 *     convenience. Account derivation is namespaced by wallet type
 *     (`getMainDerivationPath` in `lib/miden/sdk/derive-seed.ts`), so a restore
 *     only reproduces an address when it uses the SAME wallet type as the
 *     create. Production onboarding can only create GUARDIAN wallets
 *     (`Welcome.tsx` routes every create through `#choose-guardian`) and the
 *     real import screen offers only Guardian or public accounts — none of
 *     which this suite can drive: `playwright.e2e.config.ts` runs on the
 *     localnet per-PR job, which stands up no guardian backend (see
 *     `.github/workflows/pr-e2e-local.yml`). So both ends use the bypass's
 *     OffChain default, which keeps the create/restore pair type-consistent and
 *     needs no guardian. The bypass drives the same `registerWallet` call the
 *     real screens do; only the picker screens are skipped.
 *
 * No chain interaction beyond reading the address, so this spec is fast.
 */

// Vault password for both instances. Passed explicitly (rather than leaning on
// the page object's default) because the reveal flow re-authenticates with it.
const PASSWORD = 'Test1234!';

const SEED_WORD_COUNT = 12;

// Copy this flow renders, from public/_locales/en/en.json:
//   continue / verifySeedPhrasePromptTitle / verifyStepWrong / verifyStepCorrect
const CONTINUE = 'Continue';
const BACKUP_PROMPT_TITLE = 'Verify your recovery phrase';
const VERDICT_WRONG = "That's not the first and last word — tap them again";
const VERDICT_CORRECT = "That's the first and last word — tap Continue";

test.describe('Seed Phrase Backup and Verification', () => {
  test.describe.configure({ mode: 'serial' });

  test('the phrase the wallet shows me restores the same account in another wallet', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    let addressA = '';
    // The twelve words as the wallet displayed them, in order.
    let revealed: string[] = [];

    await steps.step('create_wallet_a', async () => {
      const created = await walletA.createGuardianWallet(GUARDIAN_URL, PASSWORD);
      addressA = created.address;
      // The wallet reports a COMPOSITE id — `<bech32 address>_<suffix>` — so the
      // optional trailing group is required for this to match a real address.
      expect(addressA).toMatch(/^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i);

      // Fund the account for FEES, then claim it. The restore below is a seed-only
      // recovery, which can never recover the device-bound hot key -- so the recovered
      // wallet always faces `requiresHotKeyRotation`, and that rotation is a real
      // transaction. On a fee-charging chain an unfunded account cannot pay for it and
      // the gate never clears: "failed to remove the fungible asset from the vault since
      // the amount ... is less than the amount to remove". The claim is what moves the
      // funding into the spendable vault, and it settles its own fee because a note's
      // credit lands before `pay_fee` withdraws.
      //
      // No-op on a chain that charges nothing, so this spec stays fast there.
      await midenCli.init();
      await midenCli.fundAccountForFees(addressA);
      await walletA.claimAllNotes(120_000).catch(() => {
        // Nothing to claim on a zero-fee chain: the funding was skipped, so there is no
        // note. Swallowing here keeps that path as fast as it was.
      });
    });

    await steps.step('home_offers_the_backup_prompt', async () => {
      // `useWalletPromptStorage` reads the prompt storage ONCE per mount, and
      // the home screen stays mounted — so land on a fresh home render rather
      // than racing the `seedWalletPrompt` write that `register()` performs
      // just after the wallet becomes Ready.
      await walletA.navigateTo('/');
      await expect(walletA.page.getByTestId('explore-page')).toBeVisible({ timeout: 60_000 });

      // The card a real user taps to reach the phrase. `PromptCard` renders as
      // role=button with the title in its accessible name (components/ui/
      // PromptCard.tsx), and `register()` seeds this prompt for every created
      // wallet. Asserting it here proves the route driven below is the one the
      // product actually points users at.
      await expect(
        walletA.page.getByTestId('explore-page').getByRole('button', { name: BACKUP_PROMPT_TITLE })
      ).toBeVisible({ timeout: 60_000 });
    });

    await steps.step(
      'reveal_the_seed_phrase',
      async () => {
        const page = walletA.page;
        // Exactly where the prompt card's onClick navigates
        // (WALLET_PROMPT_DEFINITIONS[VerifySeedPhrase].route). Driven by route
        // rather than by tapping the card because the card lives in a
        // drag-paged carousel alongside the faucet prompt, and a
        // transform-translated slide is not reliably clickable.
        await walletA.navigateTo('/settings/verify-seed-phrase');

        // Warning step. Its Continue stays disabled until the vault reports
        // whether a hardware protector exists, so enabled IS the ready signal.
        const warningContinue = page.getByRole('button', { name: CONTINUE, exact: true });
        await expect(warningContinue).toBeEnabled({ timeout: 60_000 });
        await warningContinue.click();

        // Auth step. Extension builds have no hardware protector, so the flow
        // always asks for the vault password before revealing anything.
        const passwordInput = page.locator('input#verify-seed-phrase-password');
        await expect(passwordInput).toBeVisible({ timeout: 30_000 });
        await passwordInput.fill(PASSWORD);
        await page.getByRole('button', { name: CONTINUE, exact: true }).click();

        // Review step: the twelve words, in order. The last chip rendering is
        // the signal that the whole grid is on screen.
        await expect(page.getByTestId(`seed-word-${SEED_WORD_COUNT - 1}`)).toBeVisible({ timeout: 30_000 });
        const words: string[] = [];
        for (let index = 0; index < SEED_WORD_COUNT; index++) {
          const word = (await page.getByTestId(`seed-word-${index}`).textContent()) ?? '';
          words.push(word.trim());
        }
        revealed = words;

        // What the user was told to write down has to be a real BIP-39 phrase:
        // twelve lowercase words, not blanks or masked placeholders.
        expect(revealed).toHaveLength(SEED_WORD_COUNT);
        expect(revealed.filter(word => /^[a-z]+$/.test(word))).toHaveLength(SEED_WORD_COUNT);
        // Also the precondition for the wrong-pair control below: with at least
        // two distinct words there is always a chip that is NOT word #1.
        expect(new Set(revealed).size).toBeGreaterThan(1);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('challenge_rejects_the_wrong_pair_and_accepts_the_shown_one', async () => {
      const page = walletA.page;
      // Review → challenge.
      await page.getByRole('button', { name: CONTINUE, exact: true }).click();

      // VerifySeedPhraseScreen spreads the host's props over its own root, so
      // under this host the container testid is the prompt-flow one, NOT
      // `verify-seed-phrase` (see VerifySeedPhraseFlow.tsx:306).
      const challenge = page.getByTestId('verify-seed-phrase-prompt-flow');
      const verdict = challenge.getByTestId('verify-seed-prompt');
      await expect(verdict).toBeVisible({ timeout: 30_000 });

      // The word chips, in the order the screen shuffled them. The submit
      // button is outside <article>, so this locator is exactly the 12 chips.
      const chips = challenge.locator('article button');
      await expect(chips).toHaveCount(SEED_WORD_COUNT);
      const chipWords = (await chips.allTextContents()).map(word => word.trim());
      // The challenge must quiz the SAME words that were just displayed —
      // same multiset, only the order differs.
      expect([...chipWords].sort()).toEqual([...revealed].sort());

      const firstWord = revealed[0]!;
      const lastWord = revealed[SEED_WORD_COUNT - 1]!;
      // Chip indices, resolved by value so a repeated word cannot confuse them:
      // the chip holding word #1, a DIFFERENT chip holding word #12 (the two
      // are distinct chips even when the phrase repeats a word), and any chip
      // that is not word #1.
      const firstChip = chipWords.indexOf(firstWord);
      const lastChip = chipWords.findIndex((word, index) => word === lastWord && index !== firstChip);
      const notFirstChip = chipWords.findIndex(word => word !== firstWord);
      expect(firstChip).toBeGreaterThanOrEqual(0);
      expect(lastChip).toBeGreaterThanOrEqual(0);
      expect(notFirstChip).toBeGreaterThanOrEqual(0);

      const submit = challenge.getByRole('button', { name: CONTINUE, exact: true });
      await expect(submit).toBeDisabled();

      // Control: a pair that is not (first, last) must be rejected — otherwise
      // "the challenge accepted my words" is worth nothing. Opening with a chip
      // that isn't word #1 is wrong regardless of what follows it.
      await chips.nth(notFirstChip).click();
      await chips.nth(firstChip).click();
      await expect(verdict).toHaveText(VERDICT_WRONG);
      await expect(submit).toBeDisabled();

      // Tapping a selected chip clears it (VerifySeedPhrase.onSelectWord), so
      // this returns the challenge to nothing-selected.
      await chips.nth(notFirstChip).click();
      await chips.nth(firstChip).click();

      // The real answer, taken from what the wallet displayed.
      await chips.nth(firstChip).click();
      await chips.nth(lastChip).click();
      await expect(verdict).toHaveText(VERDICT_CORRECT);
      await expect(submit).toBeEnabled();

      await submit.click();
      // Completing the challenge returns the user to the wallet home.
      await expect(page.getByTestId('explore-page')).toBeVisible({ timeout: 60_000 });
    });

    await steps.step(
      'restore_from_those_words_in_wallet_b',
      async () => {
        // The assertion the whole spec exists for: a fresh instance, given only
        // the words the first wallet DISPLAYED, lands on the same account.
        //
        // Restores the way a locked-out user actually would — Welcome ->
        // "Recover your account" -> the 12-word grid -> password ->
        // guardian auto-detection -> the device-key rotation gate. That is
        // also the restore path with real coverage (guardian-recovery.spec.ts),
        // which the offchain `importWallet` bypass has none of.
        await walletB.recoverGuardianFromSeed(revealed.join(' '), { viaUI: true });
        const addressB = await walletB.getAccountAddress();
        expect(addressB, 'the displayed phrase must restore the SAME account').toBe(addressA);
      },
      {
        captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }]
      }
    );
  });
});
