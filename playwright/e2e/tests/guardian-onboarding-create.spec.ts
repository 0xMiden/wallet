/**
 * "I create a wallet from scratch and it works."
 *
 * The first thing every user does, and the only spec in this suite that drives
 * it. Every other spec starts from `createNewWallet()`, which is the
 * `__test_skip_onboarding` bypass in `Welcome.tsx` — it stuffs a seed + password
 * straight into React state and jumps to the Confirmation screen. That means the
 * screens a real user actually touches (Welcome, Create password, Choose
 * guardian) have never been exercised end to end: a button that stopped
 * navigating, a password gate that stopped comparing its two fields, or a
 * guardian choice that silently failed to bind would all still leave the whole
 * suite green. So this spec must NOT use the bypass.
 *
 * THE REAL STEP ORDER ON THE EXTENSION (verified in src, not assumed):
 *
 *   Welcome                      `onboarding-welcome`
 *     └ "Get started"            → onAction 'choose-protection' (Welcome.tsx:302-308)
 *   Create password              `create-password-input`
 *     └ Continue                 → generates the mnemonic + navigates to
 *                                  '/#choose-guardian' (Welcome.tsx:389-404)
 *   Choose guardian              `onboarding-choose-guardian`
 *     └ Continue                 → WalletType.Guardian + '/#confirmation'
 *                                  (Welcome.tsx:345-361)
 *   Confirmation                 `onboarding-confirmation`
 *     └ "Open wallet"            → register() → the telemetry consent prompt
 *                                  `onboarding-help-improve-wallet`
 *     └ "Not now"                → Explore (`explore-page`)
 *
 * Three things about that order are worth stating out loud, because they differ
 * from what the flow LOOKS like it should be:
 *
 *  1. There is no "choose protection" screen here. `biometricProtectionSupported()`
 *     is `isMobile()` (Welcome.tsx:54-56), so on the extension `protectionStepRoute()`
 *     resolves straight to '/#create-password' and `onboarding-choose-protection`
 *     never renders. The spec asserts that skip rather than waiting for a screen
 *     that will never come.
 *
 *  2. There is no seed-backup and no seed-verify screen. `OnboardingStep.BackupSeedPhrase`
 *     / `VerifySeedPhrase` exist in `screens/onboarding/navigator.tsx`, but
 *     `Welcome.tsx`'s hash switch has no case that ever sets them and no action
 *     that navigates there — they are reachable only from `ForgotPassword.tsx`.
 *     The create flow generates the mnemonic silently and NEVER SHOWS IT; the
 *     user is instead nudged afterwards by the `VerifySeedPhrase` wallet prompt
 *     (`seedWalletPrompt`, Welcome.tsx:255) toward `/settings/verify-seed-phrase`.
 *     So there are no `seed-word-N` chips on this journey to capture from.
 *
 *  3. Production can only create GUARDIAN wallets. `choose-guardian-submit`
 *     unconditionally sets `WalletType.Guardian` (Welcome.tsx:345-347), so this
 *     spec exercises the guardian create path and REQUIRES a reachable guardian
 *     at `envConfig.guardianUrl`. (The bypass every other spec uses defaults to
 *     OffChain instead — another reason this path was uncovered.)
 *
 * WHAT "IT WORKS" MEANS HERE. Screens advancing proves nothing about the wallet
 * that came out the other end, so the tail of the spec funds it for real: the
 * CLI deploys a faucet and mints to the address the wallet reports, and we assert
 * the EXACT minted amount arrives as an unconsumed-note total. A mint creates a
 * NOTE — it is not spendable until claimed — so the truthful reading is
 * `pendingNoteTotal`, not the vault. That single assertion covers the whole
 * chain: a real on-chain account exists, the address the UI hands out is the
 * address the chain credits, and the wallet's own sync discovers it.
 */
import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal } from '../helpers/balance-truth';
import { dismissTelemetryConsent } from '../helpers/telemetry-consent';

/** The faucet the harness deploys (helpers/miden-cli.ts `createFaucet` defaults). */
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
/** Minted to the freshly-created wallet, in base units (1000 TST at 8 decimals). */
const MINT_BASE_UNITS = 100_000_000_000n;

/**
 * The suite-wide test password. `CreatePassword.tsx` enables Continue only when
 * more than one of {8+ chars, mixed case, letters+digits, special char, 12+ chars}
 * holds AND the two fields match; `Test1234!` satisfies four of the five.
 */
const PASSWORD = 'Test1234!';
/** Longer than PASSWORD and different from it, so the mismatch branch is unambiguous. */
const MISTYPED_PASSWORD = 'Test1234!typo';

test.describe('Onboarding — create', () => {
  test('I create a wallet from scratch and it works', async ({ walletA, midenCli, envConfig, steps, timeline }) => {
    // A guardian register (120s budget) plus CLI init, faucet deploy, mint, sync
    // and a 120s discovery wait does not fit the base config's 300s default —
    // every guardian spec in this suite sets the same 600s for the same reason
    // (guardian-send-consume, guardian-recovery, guardian-switch). Without this
    // the spec goes red on the clock rather than on a defect.
    test.setTimeout(600_000);
    const page = walletA.page;

    let address: string;
    let faucetId: string;

    await steps.step('welcome_offers_create_and_recover', async () => {
      // The fixture waits for `onboarding-welcome` OR `explore-page`; asserting
      // welcome specifically is also what proves this profile is genuinely fresh
      // rather than an already-onboarded one leaking in from a previous run.
      await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 60_000 });
      // The two doors a first-run user is given. Both must be present: losing
      // "Recover your account" here strands every returning user with a seed
      // phrase and no way in.
      await expect(page.getByTestId('onboarding-get-started')).toBeVisible();
      await expect(page.getByTestId('onboarding-recover-account')).toBeVisible();
    });

    await steps.step('get_started_leads_straight_to_the_password_step', async () => {
      await page.getByTestId('onboarding-get-started').click();
      await expect(page.getByTestId('create-password-input')).toBeVisible({ timeout: 30_000 });
      // Biometric can't work on the extension, so the create flow skips the
      // choose-protection screen entirely (Welcome.tsx:54-65). Pinned here
      // because the alternative failure — that screen rendering with a single
      // dead option — looks fine in a screenshot and dead-ends the user.
      await expect(page.getByTestId('onboarding-choose-protection')).toHaveCount(0);
    });

    await steps.step('password_step_refuses_to_continue_until_both_fields_match', async () => {
      const passwordInput = page.getByTestId('create-password-input');
      const verifyInput = page.getByTestId('create-password-verify-input');
      const submit = page.getByTestId('create-password-submit');

      await expect(submit).toBeDisabled();

      await passwordInput.fill(PASSWORD);
      // Password typed, verify still empty — the two fields differ, so Continue
      // must stay dead.
      await expect(submit).toBeDisabled();

      await verifyInput.fill(MISTYPED_PASSWORD);
      // This is the assertion that matters: a typo in the confirmation field is
      // the difference between a vault the user can open tomorrow and one they
      // can't. The screen must both refuse to continue AND say why.
      await expect(submit).toBeDisabled();
      await expect(page.getByText('Passwords do not match')).toBeVisible();

      await verifyInput.fill(PASSWORD);
      await expect(page.getByText("It's a match!")).toBeVisible();
      await expect(submit).toBeEnabled();

      await submit.click();
    });

    await steps.step('guardian_choice_is_offered_and_accepted', async () => {
      await expect(page.getByTestId('onboarding-choose-guardian')).toBeVisible({ timeout: 30_000 });

      // The picker renders one card per operator that runs a guardian on this
      // network, each tagged with the endpoint it would bind to
      // (`data-guardian-endpoint`, ChooseGuardian.tsx:142). Selecting by endpoint
      // rather than by position means the spec is asserting "the guardian this
      // run is configured for is offered", not "some card exists".
      const pickedGuardian = page.locator(`[data-guardian-endpoint="${envConfig.guardianUrl}"]`);
      await expect(pickedGuardian).toHaveCount(1);
      await pickedGuardian.click();

      await page.getByTestId('choose-guardian-continue').click();
    });

    await steps.step('confirmation_creates_the_wallet_and_lands_on_home', async () => {
      await expect(page.getByTestId('onboarding-confirmation')).toBeVisible({ timeout: 30_000 });

      // "Open wallet" is where the wallet is actually created: register() →
      // registerWallet(Guardian, password, seed, isImport=false, guardianEndpoint).
      // Everything before this point was in-memory React state.
      await page.getByTestId('onboarding-confirmation-submit').click();

      // A first-run wallet has never answered the telemetry prompt, so
      // `postCreationRoute` puts it between creation and Explore. Declined here
      // rather than accepted — see `dismissTelemetryConsent`. Raced against
      // `explore-page` with the same 120s budget as the wait below, because this
      // click only STARTS guardian creation and nothing yet proves it finished.
      await dismissTelemetryConsent(page, { nextSurface: '[data-testid="explore-page"]', timeoutMs: 120_000 });

      // The E2E build sets MIDEN_E2E_DISABLE_SIDEPANEL, so `postOnboardingRoute()`
      // is '/' and onboarding finishes in-tab on Explore. 120s is the same budget
      // `createWalletViaBypass` gives this identical post-register readiness wait,
      // which keeps this spec's share of the 300s test timeout in line with the
      // specs that reach the same point through the bypass.
      await expect(page.getByTestId('explore-page')).toBeVisible({ timeout: 120_000 });
    });

    await steps.step('the_new_wallet_has_a_real_address_bound_to_the_chosen_guardian', async () => {
      address = await walletA.getAccountAddress();
      // bech32, network-prefixed (mtst…/mdev…/…). A wallet that reports "unknown"
      // or an empty string here has no usable identity, whatever the UI showed.
      // Composite id (`<bech32 address>_<suffix>`); anchored so a truncated or
      // empty address cannot slip through on a prefix match alone.
      expect(address, 'the created wallet must report a bech32 account address').toMatch(
        /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i
      );

      // The guardian the user PICKED must be the guardian the account actually
      // bound to. `Vault.spawn` stamps `guardianEndpoint` on the account record
      // from whatever `createGuardianMidenWallet` registered with (vault.ts:461-467),
      // so this is the end-to-end check that the picker's selection survived all
      // the way into account creation — not just that the screen accepted a click.
      // Polled because the post-register StateUpdated broadcast is asynchronous.
      await expect
        .poll(() => walletA.currentGuardianEndpoint(), {
          timeout: 30_000,
          message: `the created account must be bound to the guardian selected in onboarding (${envConfig.guardianUrl})`
        })
        .toBe(envConfig.guardianUrl);

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        wallet: 'A',
        message: `Wallet created via the real onboarding UI: ${address}`,
        data: { address, guardianEndpoint: envConfig.guardianUrl }
      });
    });

    await steps.step('init_miden_client', async () => {
      await midenCli.init();
    });

    await steps.step('deploy_faucet', async () => {
      faucetId = await midenCli.createFaucet();
      expect(faucetId).toBeTruthy();
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Faucet deployed: ${faucetId}`,
        data: { faucetId }
      });
    });

    await steps.step('mint_to_the_new_wallet', async () => {
      const { txId, noteId } = await midenCli.mint(faucetId!, address!, MINT_BASE_UNITS, 'public');
      expect(txId).toBeTruthy();
      expect(noteId).toBeTruthy();
      await midenCli.sync();
    });

    await steps.step(
      'the_new_wallet_receives_the_exact_minted_amount',
      async () => {
        // The proof that the wallet is genuinely usable, not merely rendered: an
        // address that the chain credits and that this wallet's own sync
        // discovers. Asserted as an EXACT unconsumed-note total — a mint lands
        // as a note, so the vault stays 0 until it is claimed, and a
        // vault-plus-pending sum could not tell "the note arrived" apart from
        // "some other token was already here".
        await waitForPendingNoteTotal(page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: page, label: 'A', extensionId: walletA.extensionId }]
      }
    );
  });
});
