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
 * screen before the "Sign Out" click that leads to the wipe. Returns once the
 * app is on the `#/forgot-password` route AND `onboarding-welcome` has rendered;
 * that is the limit of what it establishes — nothing has been destroyed at this
 * point, the wipe happens later inside `Vault.spawn`.
 */
export async function openForgotPasswordFlow(wallet: ForgotPasswordDriver): Promise<void> {
  const page = wallet.page;

  await wallet.navigateHome();
  await page.getByTestId('unlock-password').waitFor({ timeout: 15_000 });

  // `#forgot-password` is the button's own id (Unlock.tsx) — it has no testid,
  // and driving by id is the existing harness precedent (`#import-link`,
  // `#seed-phrase-input-N`).
  await page.locator('#forgot-password').click({ timeout: 15_000 });

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

  await signOut.click({ timeout: 15_000 });

  // Checkpoint the ROUTE, not just the screen. `onboarding-welcome` is
  // `WelcomeScreen`'s testid (screens/onboarding/common/Welcome.tsx) and it is
  // rendered by the first-run onboarding host (`app/pages/Welcome.tsx`) as well
  // as by `ForgotPassword.tsx` — and the fullpage URL still carries
  // `?__test_skip_onboarding=1&password=<OLD>&walletType=guardian&…` from
  // `createWalletViaBypass` until something navigates without it. Note
  // `navigateHome()` DOES strip it — `fullpageUrl` (wallet-page.ts) builds
  // `chrome-extension://<id>/fullpage.html` with no query — so this hazard
  // applies while the bypass query is still on the URL, which is the state this
  // helper is entered in. So if a routing change ever
  // dropped this click on `/` instead, the bypass would fire and provision a
  // brand-new wallet under the OLD password while every testid below still
  // matched. `#/forgot-password-info` also contains this substring, hence the
  // end-anchored regex.
  await expect(page, 'Sign Out must land on the forgot-password route, not on first-run onboarding').toHaveURL(
    /#\/forgot-password$/,
    { timeout: 15_000 }
  );
  await page.getByTestId('onboarding-welcome').waitFor({ timeout: 15_000 });
}

/**
 * Is the wallet's encrypted-vault marker present in extension storage?
 *
 * The whole app gates on this one entry: `Vault.isExist()` is
 * `isStored(checkStrgKey)` (src/lib/miden/back/vault.ts), and `Vault.spawn`
 * writes it only at the END, once the accounts exist — well after the
 * `clearStorage()` at its Step 3 and after the guardian lookup that a failed
 * recovery dies on. So it reads true for a live wallet and false once a reset
 * has wiped storage and then failed. That before/after pair is the ONLY direct
 * evidence in this suite that the reset is genuinely destructive; without it,
 * deleting `clearStorage()` from `Vault.spawn` would leave every other
 * assertion here green.
 *
 * `safe-storage.ts` addresses vault entries by the hex SHA-256 of their logical
 * key (`wrapStorageKey`), so this recomputes that digest in-page rather than
 * guessing at a literal key name. Reading `chrome.storage.local` from the page
 * is existing harness precedent (helpers/balance-truth.ts `pendingNoteTotal`);
 * it is the same storage area the service worker writes.
 */
export async function hasVaultCheckEntry(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vault_check'));
    const hashedKey = Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
    // `Promise<any>` (as in helpers/balance-truth.ts) so `chrome.storage.local.get`
    // infers its result type from the key array rather than from the resolver.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = await new Promise<any>(resolve => {
      chrome.storage.local.get([hashedKey], resolve);
    });
    return items[hashedKey] !== undefined;
  });
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
  // Every `click` here carries an explicit ceiling. Playwright defaults
  // `actionTimeout` to 0, and `click()` auto-waits for the target to become
  // enabled — so a button that never enables (see the seed submit below) would
  // silently burn the CALLER's whole `test.setTimeout` and report a bare "Test
  // timeout" instead of naming the step that hung. The `fill` calls are left
  // unbounded on purpose: they target inputs inside a container whose testid the
  // line above has already waited for, so there is nothing left for them to wait
  // on.
  await page.locator('#import-link').click({ timeout: 15_000 });
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });

  const words = opts.seed.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    // `id="seed-phrase-input-N"` is ImportSeedPhrase.tsx's own stable per-word id.
    await page.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
  }
  // This one only becomes enabled once every word matches the BIP-39 list AND the
  // checksum validates, so its ceiling is the "the seed was rejected" diagnostic.
  await page.getByTestId('import-seed-submit').click({ timeout: 15_000 });

  await page.getByTestId('create-password-input').waitFor({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(opts.password);
  await page.getByTestId('create-password-verify-input').fill(opts.password);
  await page.getByTestId('create-password-submit').click({ timeout: 15_000 });

  await page.getByTestId('onboarding-confirmation').waitFor({ timeout: 30_000 });
  // This click is the destructive one: register() runs clearClientStorage() and
  // then registerWallet(), whose Vault.spawn wipes chrome.storage.local before
  // it attempts the guardian recovery scan.
  await page.getByTestId('onboarding-confirmation-submit').click({ timeout: 15_000 });
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
 * What this establishes: the wallet reached `Unlock`'s rejected-password state,
 * which on this screen is mutually exclusive with a successful unlock. It does
 * NOT prove the password can never work later, and it makes exactly ONE attempt —
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
  // This is the whole assertion. A follow-up `explore-page` absence check used to
  // live here and was deleted: `Unlock.tsx` makes the two states mutually
  // exclusive — `isError` is set only in `submitPasscode`'s catch branch, while
  // the success branch does `window.location.reload()` and never sets it — so
  // once the subtitle above is on screen, `explore-page` is definitionally
  // absent. It could not fail in any reachable state; it only spent 10s of the
  // caller's budget.
  await expect(
    page.getByText(INCORRECT_PASSWORD_SUBTITLE, { exact: true }),
    'the unlock form must reject this password and say so'
  ).toBeVisible({ timeout: 30_000 });
}
