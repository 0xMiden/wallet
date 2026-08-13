/**
 * Drivers for the "I forgot my password" destructive reset.
 *
 * This journey has its OWN screen chain, which is why nothing in
 * `wallet-page.ts` can be reused for it:
 *
 *   Unlock (locked)            `unlock-password`   → `#forgot-password`
 *   ForgotPasswordInfo         (no testid at all)  → "Sign Out"
 *   ForgotPassword host        `onboarding-welcome`→ `#import-link`
 *     └ ImportSeedPhrase       `import-seed-phrase`
 *     └ CreatePassword         `create-password-input`
 *     └ Confirmation           `onboarding-confirmation`
 *
 * `ChromeWalletPage.recoverGuardianFromSeed(seed, { viaUI: true })` looks close
 * enough to reuse and is NOT: it starts from a fresh Welcome
 * (`openImportSeedPhraseScreen`, i.e. `page.goto(fullpage)`), which skips the
 * locked-Unlock entry point entirely, and it then blocks on
 * `guardian-detected` / `recovery-method-continue`. `ForgotPassword.tsx` renders
 * `OnboardingFlow` without `OnboardingStep.ImportSelectRecoveryMethod`, so those
 * testids never appear on this route and that helper would hang.
 *
 * Lives in its own module (not in `wallet-page.ts`) per the harness rule that
 * parallel work must not converge on that file.
 */
import { expect, type Page } from '@playwright/test';

import type { ChromeWalletPageApi } from './wallet-page';

/**
 * `data-testid` on the recovery-failure text rendered by
 * `screens/onboarding/common/Confirmation.tsx`. The message itself is dynamic
 * (it is whatever the backend rejected with), so there is nothing stable to
 * text-match on — this hook was added to `src/` for exactly this journey.
 */
export const RECOVERY_ERROR_TESTID = 'onboarding-recovery-error';

/** `Unlock.tsx` password-form subtitle for a rejected password (`incorrectPassword` in en.json). */
const INCORRECT_PASSWORD_SUBTITLE = 'Incorrect password. Try again.';

/**
 * `ForgotPasswordInfo.tsx`'s only forward control. `Button` renders its `title`
 * prop as the button's text (components/Button.tsx), so the accessible name is
 * the sole stable hook on a screen that carries no `data-testid`.
 */
const SIGN_OUT_BUTTON = 'Sign Out';

/**
 * The seed-phrase warning on `ForgotPasswordInfo` (`forgotPasswordSecondDescription`).
 * The ONLY thing standing between a user who mistyped their password and an
 * irreversible wipe, so `openForgotPasswordFlow` refuses to walk past it silently.
 */
const SIGN_OUT_WARNING = 'Do not sign out unless you know your 12-word Seed phrase or have an encrypted backup file.';

/** The slice of the Chrome page object these drivers need. */
type ForgotPasswordDriver = Pick<ChromeWalletPageApi, 'page' | 'navigateHome' | 'completeHotKeyRotation'>;

/**
 * From a LOCKED wallet, walk the real entry route to the reset flow's first
 * screen: Unlock → `#forgot-password` → ForgotPasswordInfo → "Sign Out" →
 * the ForgotPassword host at its Welcome step.
 *
 * Asserts on the way through that the destructive-reset warning is actually on
 * screen before the "Sign Out" click that leads to the wipe. Returns once
 * `onboarding-welcome` has rendered; that is the limit of what it establishes —
 * nothing has been destroyed at this point, the wipe happens later inside
 * `Vault.spawn`.
 */
export async function openForgotPasswordFlow(wallet: ForgotPasswordDriver): Promise<void> {
  const page = wallet.page;

  await wallet.navigateHome();
  await page.getByTestId('unlock-password').waitFor({ timeout: 15_000 });

  // `#forgot-password` is the button's own id (Unlock.tsx) — it has no testid,
  // and driving by id is the existing harness precedent (`#import-link`,
  // `#seed-phrase-input-N`).
  await page.locator('#forgot-password').click();

  const signOut = page.getByRole('button', { name: SIGN_OUT_BUTTON });
  await signOut.waitFor({ timeout: 15_000 });

  // The interstitial exists to warn that signing out is irreversible without the
  // seed phrase. A build that routed `#forgot-password` straight at the seed grid,
  // or dropped this line, would take the wipe from "informed choice" to "trap" —
  // and every other check in this file would stay green.
  await expect(
    page.getByText(SIGN_OUT_WARNING),
    'the forgot-password interstitial must warn that signing out needs the seed phrase, BEFORE the wipe'
  ).toBeVisible({ timeout: 15_000 });

  await signOut.click();

  await page.getByTestId('onboarding-welcome').waitFor({ timeout: 15_000 });
}

/**
 * From the ForgotPassword host's Welcome step, drive "Recover your account" →
 * 12-word seed grid → new password (twice) → Confirmation → "Open wallet".
 *
 * Returns immediately after the confirmation click, i.e. with registration
 * IN FLIGHT — it deliberately does not wait for an outcome, because both
 * outcomes (a recovered wallet, or a failure surfaced in place) are things
 * callers assert on differently.
 */
export async function submitRecoveryFromSeed(page: Page, opts: { seed: string; password: string }): Promise<void> {
  await page.locator('#import-link').click();
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });

  const words = opts.seed.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    // `id="seed-phrase-input-N"` is ImportSeedPhrase.tsx's own stable per-word id.
    await page.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
  }
  // `.click()` auto-waits for the button to become enabled, which only happens
  // once every word matches the BIP-39 list AND the checksum validates.
  await page.getByTestId('import-seed-submit').click();

  await page.getByTestId('create-password-input').waitFor({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(opts.password);
  await page.getByTestId('create-password-verify-input').fill(opts.password);
  await page.getByTestId('create-password-submit').click();

  await page.getByTestId('onboarding-confirmation').waitFor({ timeout: 30_000 });
  // This click is the destructive one: register() runs clearClientStorage() and
  // then registerWallet(), whose Vault.spawn wipes chrome.storage.local before
  // it attempts the guardian recovery scan.
  await page.getByTestId('onboarding-confirmation-submit').click();
}

/**
 * The whole happy-path journey: locked Unlock → reset flow → recovered wallet
 * re-keyed to `newPassword`, with the device-key rotation gate cleared.
 *
 * Resolves only once `HotKeyRotationGate` has unmounted, so a caller that
 * returns from this has a wallet that is Ready and rotated. If the recovery
 * FAILS instead, this throws carrying the on-screen reason rather than letting
 * the rotation-gate wait expire with an opaque "gate never appeared" timeout.
 */
export async function recoverViaForgotPassword(
  wallet: ForgotPasswordDriver,
  opts: { seed: string; newPassword: string }
): Promise<void> {
  await openForgotPasswordFlow(wallet);
  await submitRecoveryFromSeed(wallet.page, { seed: opts.seed, password: opts.newPassword });

  // Registration has exactly two terminal surfaces: the app-wide rotation gate
  // (recovery succeeded — a seed-only recovery can never recover the
  // device-bound hot key, so rotation is always required), or the failure text
  // left in place on the confirmation screen (#630).
  const gate = wallet.page.getByTestId('hot-key-rotation-gate');
  const failure = wallet.page.getByTestId(RECOVERY_ERROR_TESTID);
  // 120s is 4x the 30s `completeHotKeyRotation` already proves sufficient for
  // this same register-then-gate hop in `recoverGuardianFromSeed`, and comfortably
  // covers the failure path (three guardian lookups before RECOVERY_GAP_LIMIT).
  await gate.or(failure).first().waitFor({ state: 'visible', timeout: 120_000 });
  if (await failure.isVisible()) {
    throw new Error(
      `recoverViaForgotPassword: recovery failed instead of completing — the confirmation screen reported: ` +
        `${(await failure.innerText()).trim()}`
    );
  }

  await wallet.completeHotKeyRotation();
}

/**
 * Assert that `password` does NOT open the vault.
 *
 * What this establishes: the wallet reached `Unlock`'s rejected-password state
 * and, at that moment, the wallet home is not rendered. It does NOT prove the
 * password can never work later, and it deliberately makes exactly ONE attempt —
 * `Unlock.tsx` time-locks the form for 60s on the third consecutive failure, so
 * a retry loop here would poison any subsequent unlock in the same test.
 */
export async function expectUnlockRejects(
  wallet: Pick<ChromeWalletPageApi, 'page' | 'navigateHome'>,
  password: string
): Promise<void> {
  const page = wallet.page;

  await wallet.navigateHome();
  await page.getByTestId('unlock-password').waitFor({ timeout: 15_000 });

  await page.locator('#unlock-password').fill(password);
  await page.locator('#unlock-password').press('Enter');

  // A rejected unlock is one service-worker round trip, so 30s is generous; the
  // ceiling exists to keep this helper's contribution to a caller's test budget
  // small and predictable.
  await expect(
    page.getByText(INCORRECT_PASSWORD_SUBTITLE, { exact: true }),
    'the unlock form must reject this password and say so'
  ).toBeVisible({ timeout: 30_000 });

  // Checked only AFTER the rejection is on screen: a successful unlock reloads
  // the page onto the wallet home (Unlock.tsx `window.location.reload()`), so
  // asserting this first would pass simply by running before the vault answered.
  // By this point the answer is in, so a short ceiling is the right one.
  await expect(page.getByTestId('explore-page'), 'a rejected password must not have opened the wallet').toHaveCount(0, {
    timeout: 10_000
  });
}
