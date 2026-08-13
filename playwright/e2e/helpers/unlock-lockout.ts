/**
 * Drivers for the extension unlock screen's REJECTION path.
 *
 * WHY THIS EXISTS
 *
 * `ChromeWalletPage.unlockWallet()` only knows the correct password: it fills,
 * presses Enter and waits for `explore-page`. Nothing in the Chrome suite has
 * ever typed a WRONG one, so the escalating lockout in `src/app/pages/Unlock.tsx`
 * — real product behaviour, not a test fixture — is unexercised end to end.
 *
 * THE PRODUCT BEHAVIOUR THESE HELPERS DRIVE (src/app/pages/Unlock.tsx)
 *
 *   LOCK_TIME = 60_000, LAST_ATTEMPT = 3, `attempt` starts at 1 and both
 *   `attempt` and `timelock` persist in localStorage, so they survive the reload
 *   `lockWallet()` performs.
 *
 *     fail #1 -> attempt=2, lockLevel=0                        -> NOT disabled
 *     fail #2 -> attempt=3, lockLevel=60_000 but timelock=0    -> NOT disabled
 *                (`Date.now() - 0 <= 60_000` is false)
 *     fail #3 -> `attempt >= LAST_ATTEMPT` arms setTimeLock(Date.now()),
 *                attempt=4, lockLevel=60_000                   -> DISABLED, 60s
 *
 *   THREE wrong passwords are the minimum to render the lockout, and the first
 *   tier is exactly 60 seconds. A 1s interval clears it with `setTimeLock(0)`
 *   once it expires, with no user action.
 *
 * THE TRAP THESE HELPERS EXIST TO AVOID
 *
 * `playwright.e2e.config.ts` sets no `actionTimeout`, so it defaults to 0 =
 * unbounded, and Playwright's `fill()` auto-waits for the element to be enabled.
 * A spec that simply calls `unlockWallet()` after the lockout renders therefore
 * blocks ~60s inside `fill()` and then succeeds — GREEN while having asserted
 * nothing about the lockout, and still green if the lockout were ten minutes
 * long or never rendered at all. The re-enable has to be an explicit, bounded
 * assertion BEFORE the unlock, which is what `waitForLockoutToExpire` is.
 *
 * Assertions here are on the `disabled` attribute and on the countdown's
 * `\d{2}:\d{2}` SHAPE (formatted by code at Unlock.tsx `getTimeLeft`), never on
 * the English copy around it — that string lives in `public/_locales/en/en.json`
 * and is translator-owned.
 */
import { expect, type Page } from '@playwright/test';

/** The extension/desktop password field. The 6-digit numpad is mobile-only. */
const PASSWORD_INPUT = '#unlock-password';

/** The unlock screen's subtitle line: empty when idle, the error/countdown otherwise. */
const ERROR_TESTID = 'unlock-error';

/**
 * Wrong passwords needed before the lockout renders. Mirrors `LAST_ATTEMPT = 3`
 * in Unlock.tsx — see the arithmetic in this module's header. Two is NOT enough.
 */
export const WRONG_PASSWORDS_TO_LOCKOUT = 3;

/** Unlock.tsx `LOCK_TIME`: the first lockout tier, in ms. */
export const LOCKOUT_MS = 60_000;

/**
 * The countdown the lockout subtitle renders, e.g. `01:00`. Produced by
 * `getTimeLeft`/`checkTime` in Unlock.tsx, so it is code-shaped and stable
 * across locales — unlike the sentence it is appended to.
 */
const COUNTDOWN = /\b\d{2}:\d{2}\b/;

/**
 * A re-enable faster than this cannot be a real LOCK_TIME expiring.
 *
 * `timelock` is stamped at the third rejection and the field re-enables at
 * `timelock + 60s` (plus up to 1s of interval granularity), so a genuine wait
 * measured from "we have observed the disabled state" lands around 57-60s. The
 * floor is set at half of that: comfortably below any real run, and far enough
 * above zero to catch a phantom lock that clears immediately — which would
 * otherwise let `toBeEnabled` pass without the lockout ever having engaged.
 */
const MIN_PLAUSIBLE_LOCKOUT_MS = 30_000;

/** Everything worth quoting when an unlock-screen wait fails. Never throws itself. */
async function describeUnlockScreen(page: Page): Promise<string> {
  const subtitle = await page
    .getByTestId(ERROR_TESTID)
    .textContent()
    .catch(() => '<unreadable>');
  const disabled = await page
    .locator(PASSWORD_INPUT)
    .getAttribute('disabled')
    .catch(() => '<unreadable>');
  return (
    `  subtitle (data-testid="${ERROR_TESTID}"): ${JSON.stringify(subtitle ?? '')}\n` +
    `  ${PASSWORD_INPUT} disabled attribute: ${disabled === null ? 'absent (field is enabled)' : JSON.stringify(disabled)}`
  );
}

/**
 * Type a password that is NOT the vault password, submit it, and wait until the
 * screen has rendered the rejection.
 *
 * `wrongPassword` MUST differ between calls. `onPasswordChange` clears `isError`
 * on every keystroke, so a distinct value gives two separately observable
 * signals per attempt — the previous error clearing, then the new one arriving —
 * which is what keeps `submitPasscode`'s `attempt` closure from being
 * mis-sequenced by a stale render. Re-typing the same value gives neither.
 *
 * Throws if the screen never shows a rejection: a wrong password that is quietly
 * ACCEPTED, or one whose rejection never surfaces, is precisely the bug this
 * spec is for, so it must fail loudly rather than fall through.
 */
export async function submitWrongPassword(
  page: Page,
  wrongPassword: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const input = page.locator(PASSWORD_INPUT);
  const error = page.getByTestId(ERROR_TESTID);

  try {
    // Bounded on purpose. Without it, `fill()` below would silently absorb an
    // unexpected disabled state for as long as the test timeout allows.
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.fill(wrongPassword);

    // The typing itself must have cleared any previous attempt's error, or the
    // "rejected" signal below could just be the PREVIOUS rejection still on
    // screen — an attempt that was never actually submitted would read as
    // rejected.
    await expect(error).toBeEmpty({ timeout: 15_000 });

    await input.press('Enter');

    // The real signal: the vault ran a full PBKDF2 derive and the AES-GCM open
    // failed (`Invalid password`), which surfaces here as a non-empty subtitle —
    // "Incorrect password" for attempts 1-2, the lockout countdown on the third.
    await expect(error).not.toBeEmpty({ timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `submitWrongPassword(${JSON.stringify(wrongPassword)}) did not observe a rejection within ${timeoutMs}ms.\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  An empty subtitle with an enabled field means the wrong password was neither accepted nor rejected;\n` +
        `  reaching the home screen instead would mean it was ACCEPTED.\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Assert the lockout is rendered right now: the password field is disabled AND
 * the subtitle carries a countdown.
 *
 * Both halves matter. A disabled field alone could be an in-flight submit; a
 * countdown alone would not prove the form actually refuses input.
 */
export async function expectLockedOut(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    await expect(page.locator(PASSWORD_INPUT)).toBeDisabled({ timeout: timeoutMs });
    await expect(page.getByTestId(ERROR_TESTID)).toHaveText(COUNTDOWN, { timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `expectLockedOut: the unlock screen is not in the locked-out state after ` +
        `${WRONG_PASSWORDS_TO_LOCKOUT} wrong passwords.\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  expected: ${PASSWORD_INPUT} disabled, and the subtitle matching ${COUNTDOWN}\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Wait out the lockout and prove it cleared ON ITS OWN, returning how long that
 * took in ms.
 *
 * Call this only after `expectLockedOut` has confirmed the locked state — this
 * helper asserts a TRANSITION, and without the prior assertion `toBeEnabled`
 * would be trivially true against a screen that never locked.
 *
 * The timeout must be passed explicitly and exceed LOCK_TIME: the suite's global
 * `expect.timeout` is 60_000, which would fire just as the lockout is expiring.
 */
export async function waitForLockoutToExpire(page: Page, opts: { timeoutMs?: number } = {}): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const input = page.locator(PASSWORD_INPUT);
  const startedAt = Date.now();

  try {
    await expect(input).toBeEnabled({ timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} was still disabled after ${Date.now() - startedAt}ms ` +
        `(budget ${timeoutMs}ms, LOCK_TIME is ${LOCKOUT_MS}ms).\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  A countdown frozen at the same value means Unlock.tsx's 1s interval is not clearing the timelock.\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const waitedMs = Date.now() - startedAt;
  if (waitedMs < MIN_PLAUSIBLE_LOCKOUT_MS) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} re-enabled after only ${waitedMs}ms.\n` +
        `  LOCK_TIME is ${LOCKOUT_MS}ms, so a real lockout cannot clear in under ${MIN_PLAUSIBLE_LOCKOUT_MS}ms.\n` +
        `  The field being enabled again is therefore not evidence the lockout ran its course — either the\n` +
        `  timelock was never armed for a full LOCK_TIME, or the disabled state observed just before this\n` +
        `  was something other than the lockout.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }

  // The countdown must be gone too, not merely the disabled attribute. A field
  // that accepts input while still advertising a lockout is a broken screen.
  try {
    await expect(page.getByTestId(ERROR_TESTID)).not.toHaveText(COUNTDOWN, { timeout: 15_000 });
  } catch (err) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} re-enabled after ${waitedMs}ms but the lockout countdown ` +
        `is still on screen.\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return waitedMs;
}
