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
 *   Each of those three claims is pinned by an assertion here, not just by this
 *   comment: `expectNotLockedOut` after rejections #1 and #2 (the field is still
 *   usable AT THAT INSTANT, so a lockout that armed early cannot be absorbed as
 *   a wait), the countdown's opening value and its ticking in `expectLockedOut`,
 *   and the measured hold in `waitForLockoutToExpire`.
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
 * Assertions here are on the `disabled` attribute, on the countdown's NUMERIC
 * value (parsed out of the `mm:ss` that `getTimeLeft` formats), and on the
 * timelock the product itself stamps into localStorage — never on the English
 * copy around them, which lives in `public/_locales/en/en.json` and is
 * translator-owned.
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
 * `MidenSharedStorageKey.TimeLock` (src/lib/miden/types.ts). Unlock.tsx stamps
 * `Date.now()` here through `useLocalStorage`, which JSON-encodes, so the stored
 * value is a bare number. This is the PRODUCT's clock for the lockout, and the
 * only origin a duration measured by the harness can honestly be taken from.
 */
const TIMELOCK_STORAGE_KEY = 'TimeLock';

/**
 * The countdown the lockout subtitle renders, e.g. `01:00`. Produced by
 * `getTimeLeft`/`checkTime` in Unlock.tsx, so it is code-shaped and stable
 * across locales — unlike the sentence it is appended to. Captured, not just
 * matched: the SHAPE alone is satisfied by `00:00` and by `99:99`, so shape is
 * the parse step and the numbers are what get asserted.
 */
const COUNTDOWN = /\b(\d{2}):(\d{2})\b/;

/** How long to watch the countdown for a decrement before calling it frozen. */
const COUNTDOWN_TICK_BUDGET_MS = 6_000;

/**
 * Every read below passes one explicitly. `playwright.e2e.config.ts` sets no
 * `actionTimeout`, so the default is 0 = UNBOUNDED: a `textContent()` taken
 * after a wrong password was wrongly ACCEPTED (the unlock screen is gone) would
 * otherwise hang until the outer test timeout and be reported as a timeout
 * rather than as the accepted password it is.
 */
const READ_TIMEOUT_MS = 5_000;

/** Everything worth quoting when an unlock-screen wait fails. Never throws itself. */
async function describeUnlockScreen(page: Page): Promise<string> {
  const subtitle = await page
    .getByTestId(ERROR_TESTID)
    .textContent({ timeout: READ_TIMEOUT_MS })
    .catch(() => '<unreadable>');
  const disabled = await page
    .locator(PASSWORD_INPUT)
    .getAttribute('disabled', { timeout: READ_TIMEOUT_MS })
    .catch(() => '<unreadable>');
  const timelock = await page
    .evaluate(key => localStorage.getItem(key), TIMELOCK_STORAGE_KEY)
    .catch(() => '<unreadable>');
  return (
    `  subtitle (data-testid="${ERROR_TESTID}"): ${JSON.stringify(subtitle ?? '')}\n` +
    `  ${PASSWORD_INPUT} disabled attribute: ${disabled === null ? 'absent (field is enabled)' : JSON.stringify(disabled)}\n` +
    `  localStorage["${TIMELOCK_STORAGE_KEY}"]: ${JSON.stringify(timelock)}`
  );
}

/** Parse the subtitle's `mm:ss` countdown into whole seconds, or throw naming what was on screen. */
async function readCountdownSeconds(page: Page, context: string): Promise<number> {
  const text = (await page.getByTestId(ERROR_TESTID).textContent({ timeout: READ_TIMEOUT_MS })) ?? '';
  const matched = text.match(COUNTDOWN);
  if (!matched) {
    throw new Error(
      `${context}: the unlock subtitle carries no ${COUNTDOWN} countdown.\n  subtitle: ${JSON.stringify(text)}`
    );
  }
  return Number(matched[1]) * 60 + Number(matched[2]);
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
  // A rejection is one PBKDF2 derive plus a 300ms sleep and a render — the same
  // work `unlockWallet()` budgets 30s for on the SUCCESS path. Budgeting more
  // here would only mean a hung derive burns the outer test timeout instead of
  // reporting itself.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const input = page.locator(PASSWORD_INPUT);
  const error = page.getByTestId(ERROR_TESTID);

  try {
    // Instantaneous, NOT a wait. `Input` derives `disabled` from `isDisabled`
    // alone (never from `isSubmitting`), so the field is enabled the moment the
    // previous rejection has rendered. A generous timeout here would silently
    // absorb a lockout that armed earlier than the third attempt — the exact
    // claim this spec makes.
    await expect(input).toBeEnabled({ timeout: 1_000 });
    await input.fill(wrongPassword);

    // The typing itself must have cleared any previous attempt's error, or the
    // "rejected" signal below could just be the PREVIOUS rejection still on
    // screen — an attempt that was never actually submitted would read as
    // rejected.
    await expect(error).toBeEmpty({ timeout: 10_000 });

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
 * Assert the lockout has NOT armed yet: read the field's `disabled` attribute
 * and the subtitle ONCE, right now.
 *
 * This is what makes "three wrong passwords, not two" a tested fact rather than
 * a comment. Every other check in this module tolerates a wait, and a wait is
 * exactly what would hide an early lockout: `fill()` and `toBeEnabled` both
 * absorb a disabled field by sitting on it until it clears, so a wallet that
 * locked out after ONE wrong password would still reach the end of the spec.
 */
export async function expectNotLockedOut(page: Page, afterWrongAttempts: number): Promise<void> {
  const disabled = await page.locator(PASSWORD_INPUT).getAttribute('disabled', { timeout: READ_TIMEOUT_MS });
  if (disabled !== null) {
    throw new Error(
      `expectNotLockedOut: ${PASSWORD_INPUT} is already disabled after only ${afterWrongAttempts} wrong ` +
        `password(s).\n` +
        `  Unlock.tsx arms the timelock at \`attempt >= LAST_ATTEMPT\` (3), so the field must still accept ` +
        `input here.\n` +
        `  A lockout this early is a product change, not a slow render — the attempt counter is synchronous.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }

  const subtitle = (await page.getByTestId(ERROR_TESTID).textContent({ timeout: READ_TIMEOUT_MS })) ?? '';
  if (COUNTDOWN.test(subtitle)) {
    throw new Error(
      `expectNotLockedOut: the unlock subtitle is already showing a lockout countdown after only ` +
        `${afterWrongAttempts} wrong password(s).\n` +
        `  subtitle: ${JSON.stringify(subtitle)}\n` +
        `  expected the plain "incorrect password" copy, with no ${COUNTDOWN}.`
    );
  }
}

/**
 * Assert the lockout is rendered right now: the password field is disabled, the
 * subtitle carries a countdown that OPENS at the documented first tier, and that
 * countdown is ticking down.
 *
 * All three matter. A disabled field alone could be an in-flight submit. A
 * countdown alone would not prove the form refuses input. And a countdown's
 * SHAPE alone proves nothing about its value: `00:00` frozen from the first
 * frame is `dd:dd`, and so is the `00:39` a LOCK_TIME quietly cut to 40 seconds
 * would render.
 */
export async function expectLockedOut(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
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

  // Unlock.tsx renders `getTimeLeft(Date.now(), LOCK_TIME)` on the rejection that
  // arms the timelock — one full tier, formatted as `01:00` or `00:59` depending
  // on where the sub-millisecond drift inside `getTimeLeft` falls — and the 1s
  // interval walks it down from there. Anything above the tier means the lockout
  // is LONGER than documented; zero means the timer is degenerate.
  const tierSeconds = LOCKOUT_MS / 1_000;
  const opening = await readCountdownSeconds(page, 'expectLockedOut');
  if (opening <= 0 || opening > tierSeconds) {
    throw new Error(
      `expectLockedOut: the lockout countdown opened at ${opening}s, outside the documented first tier ` +
        `of ${tierSeconds}s.\n` +
        `  above the tier: the user is locked out for longer than LOCK_TIME says.\n` +
        `  zero: the countdown is degenerate — it renders 00:00 while the field is still disabled.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }

  // ...and it has to MOVE. A timer frozen at its opening value is a broken
  // screen that every shape- and range-check above still passes.
  const deadline = Date.now() + COUNTDOWN_TICK_BUDGET_MS;
  let latest = opening;
  while (latest >= opening && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    latest = await readCountdownSeconds(page, 'expectLockedOut');
  }
  if (latest >= opening) {
    throw new Error(
      `expectLockedOut: the lockout countdown is frozen at ${opening}s — it did not decrement within ` +
        `${COUNTDOWN_TICK_BUDGET_MS}ms.\n` +
        `  Unlock.tsx re-renders it from a 1s interval, and that same interval is what clears the timelock,\n` +
        `  so a frozen countdown means the lockout will never release itself either.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }
}

/** The moment Unlock.tsx armed the timelock, read out of the product's own localStorage. */
async function readArmedTimelock(page: Page): Promise<number> {
  const raw = await page.evaluate(key => localStorage.getItem(key), TIMELOCK_STORAGE_KEY);
  const armedAt = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(armedAt) || armedAt <= 0) {
    throw new Error(
      `waitForLockoutToExpire: localStorage["${TIMELOCK_STORAGE_KEY}"] is ${JSON.stringify(raw)}, so no timelock ` +
        `is armed.\n` +
        `  Unlock.tsx derives \`isDisabled\` from exactly this value, so the disabled field observed a moment\n` +
        `  ago was something other than the lockout — which would make every duration measured from here\n` +
        `  meaningless.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }
  return armedAt;
}

/**
 * Wait out the lockout and prove it cleared ON ITS OWN after a full LOCK_TIME,
 * returning how long the product actually held it, in ms.
 *
 * Call this only after `expectLockedOut` has confirmed the locked state — this
 * helper asserts a TRANSITION, and without the prior assertion `toBeEnabled`
 * would be trivially true against a screen that never locked.
 *
 * The duration is measured from the timelock the PRODUCT stamped, not from this
 * function's entry. Everything the harness spends between the arming and this
 * call — the 300ms sleep in Unlock.tsx, the `expectLockedOut` round-trips and
 * its countdown sampling, the post-step screenshot — would otherwise be
 * subtracted from the real lockout, so on a slow runner a perfectly working 60s
 * lockout could measure as a suspiciously short one and be reported as a product
 * bug that does not exist.
 *
 * The timeout must be passed explicitly and exceed LOCK_TIME: the suite's global
 * `expect.timeout` is 60_000, which would fire just as the lockout is expiring.
 */
export async function waitForLockoutToExpire(page: Page, opts: { timeoutMs?: number } = {}): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const input = page.locator(PASSWORD_INPUT);
  const armedAt = await readArmedTimelock(page);
  const startedAt = Date.now();

  try {
    await expect(input).toBeEnabled({ timeout: timeoutMs });
  } catch (err) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} was still disabled after ${Date.now() - startedAt}ms ` +
        `(budget ${timeoutMs}ms, LOCK_TIME is ${LOCKOUT_MS}ms, timelock armed ${Date.now() - armedAt}ms ago).\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  A countdown frozen at the same value means Unlock.tsx's 1s interval is not clearing the timelock.\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const heldMs = Date.now() - armedAt;
  if (heldMs < LOCKOUT_MS) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} re-enabled ${heldMs}ms after Unlock.tsx armed the timelock, ` +
        `but LOCK_TIME is ${LOCKOUT_MS}ms.\n` +
        `  The lockout is therefore SHORTER than the tier the screen counted down from: a wallet the user was\n` +
        `  told is locked for a minute became typeable sooner than that.\n` +
        `${await describeUnlockScreen(page)}`
    );
  }

  // The countdown must be gone too, not merely the disabled attribute. A field
  // that accepts input while still advertising a lockout is a broken screen.
  try {
    await expect(page.getByTestId(ERROR_TESTID)).not.toHaveText(COUNTDOWN, { timeout: 15_000 });
  } catch (err) {
    throw new Error(
      `waitForLockoutToExpire: ${PASSWORD_INPUT} re-enabled after ${heldMs}ms but the lockout countdown ` +
        `is still on screen.\n` +
        `${await describeUnlockScreen(page)}\n` +
        `  underlying: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return heldMs;
}
