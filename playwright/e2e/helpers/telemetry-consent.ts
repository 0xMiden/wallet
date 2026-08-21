/**
 * The one-time telemetry consent prompt (`/help-improve-wallet`), and how every
 * suite that finishes onboarding gets past it.
 *
 * Onboarding gained a screen. `Welcome.tsx`'s `postCreationRoute()` sends a
 * freshly created OR recovered wallet to `/help-improve-wallet` instead of
 * straight to `postOnboardingRoute()` whenever `hasTelemetryChoice()` is false,
 * so the chain is now
 *
 *   confirmation → consent → /finish-side-panel (Chrome) or / (everywhere else)
 *
 * That is the intended product behaviour. What was wrong was the harness: every
 * driver clicked `onboarding-confirmation-submit` and then waited for a
 * post-onboarding surface that is now one screen further away, so the run parked
 * on the consent prompt until the wait expired.
 */
import { errors, type Page } from '@playwright/test';

/** `HelpImproveWallet.tsx`'s container — the prompt is up iff this is mounted. */
export const TELEMETRY_CONSENT_TESTID = 'onboarding-help-improve-wallet';

/** The prompt's "Not now" button. See `dismissTelemetryConsent` for why this one. */
export const TELEMETRY_CONSENT_DECLINE_TESTID = 'help-improve-wallet-decline';

const PROMPT_SELECTOR = `[data-testid="${TELEMETRY_CONSENT_TESTID}"]`;
const DECLINE_SELECTOR = `[data-testid="${TELEMETRY_CONSENT_DECLINE_TESTID}"]`;

/**
 * `HotKeyRotationGate.tsx`'s scrim — the one thing in the app that can render
 * ON TOP of the consent prompt. See {@link ROTATION_GATE_HINT}.
 */
const ROTATION_GATE_SELECTOR = '[data-testid="hot-key-rotation-gate"]';

/**
 * Attached to the failure when the decline click is blocked by the rotation
 * gate, because the raw Playwright message for it ("element is not stable",
 * repeated until the timeout) names neither the scrim nor the fix.
 *
 * `HotKeyRotationGate` is a sibling of `PageRouter` in `App.tsx` and paints a
 * `fixed inset-0 z-[9999]` scrim over whatever route is mounted. A Guardian
 * wallet adopted from a seed phrase is flagged `requiresHotKeyRotation`
 * (`Vault.spawn`'s `recoveredCold` branch) at the same store update that ends a
 * driver's post-`register()` readiness wait — so on that one path the prompt is
 * on screen, and unclickable, from before it is even routed to until the
 * rotation lands on-chain.
 *
 * Waiting that out is deliberately NOT this function's job. A rotation proves
 * an on-chain `replace_signer` and is bounded by nothing a timeout here could
 * be sized against; and the specs that drive rotation faults need the gate
 * still standing when their recovery call returns, so blocking on it here would
 * deadlock them. `completeHotKeyRotation()` — which every path that raises the
 * gate already awaits, and which resolves exactly when the gate detaches —
 * dismisses the prompt instead.
 */
const ROTATION_GATE_HINT =
  `the HotKeyRotationGate scrim is up, so the prompt is covered and cannot be clicked. Dismissal on a ` +
  `rotating wallet belongs to completeHotKeyRotation(), which runs it the moment the gate detaches — this ` +
  `call site must not attempt it itself. Do NOT "fix" this with force: true (it would press a button no ` +
  `user could reach) or with a longer timeout (a rotation is network-bound and has no fixed duration).`;

/**
 * Ceiling for "is the prompt on screen?". Short ON PURPOSE: the prompt is
 * OPTIONAL (see `dismissTelemetryConsent`), so this is the price every run that
 * never sees it pays, and it must stay negligible against a caller's test
 * budget. Only safe on its own where the caller has ALREADY observed the wallet
 * finish registering; everyone else passes `nextSurface` rather than raising it.
 */
export const TELEMETRY_CONSENT_TIMEOUT_MS = 5_000;

/**
 * Ceiling for the decline click and the unmount that follows it. Deliberately
 * not the caller's `timeoutMs`: by then the prompt has been SEEN, so these act
 * on an element already on screen and only have one navigation to wait out.
 * Keeping them separate lets `timeoutMs` mean exactly one thing — how long the
 * prompt has to show up.
 */
const CONSENT_ACTION_TIMEOUT_MS = 5_000;

/** Poll interval for the CDP path, which has no locators to auto-wait on. */
const CDP_POLL_INTERVAL_MS = 250;

/**
 * The slice of `IosWalletPage` / `AndroidWalletPage` this needs. Those page
 * objects drive a WebView over CDP rather than a Playwright `Page`, so they have
 * no locators — they carry `evalJs` + `click(cssSelector)` + `delay` instead,
 * which is exactly the shape below. It is also why every selector in this module
 * is a CSS string: it is the one form both drivers speak.
 */
export interface TelemetryConsentCdpDriver {
  evalJs<T = unknown>(js: string): Promise<T>;
  click(selector: string): Promise<void>;
  delay(ms: number): Promise<void>;
}

export interface DismissTelemetryConsentOptions {
  /** Defaults to {@link TELEMETRY_CONSENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * CSS selector for the surface this flow lands on when the prompt does NOT
   * appear — pass it whenever the caller has not already observed something that
   * proves `register()` finished AND routed. Until then, "there is no prompt"
   * and "the prompt has not arrived yet" look identical from outside, so a bare
   * short poll would race ahead of a prompt that was still coming. With this
   * set, the wait ends on whichever of the two appears first: it can neither
   * miss the prompt nor hang when there is not one, and `timeoutMs` should then
   * be the caller's own budget for reaching that surface.
   */
  nextSurface?: string;
}

/**
 * Dismiss the telemetry consent prompt by DECLINING it, if it is up.
 *
 * DECLINE, NOT ACCEPT — do not "fix" this to press "Share usage data". Accepting
 * writes consent=true into the test browser, which arms the crash reporter
 * (`initCrashReporting`) and the product-event egress for the rest of that
 * profile's life. An e2e suite must never run in a state where a wallet under
 * test can ship anything to Sentry or to the product-analytics endpoint, and
 * declining is also the shipped default, so it is the state the rest of the
 * suite already assumes. Both buttons record an answer, so either one gets the
 * flow moving; only one of them keeps the harness silent.
 *
 * The prompt is OPTIONAL, not guaranteed. `PageRouter` SKIPs
 * `/help-improve-wallet` when the app is locked or when `hasTelemetryChoice()`
 * is already true, and `postCreationRoute()` only detours through it for a
 * profile that has never answered. So a test whose profile carries a stored
 * choice, or that is sitting on Unlock, will never see it — waiting
 * unconditionally would cost those runs the whole timeout for nothing. Absence
 * is therefore a normal outcome, reported as `false`; anything OTHER than "it
 * never showed up" propagates.
 *
 * Requires the prompt to be REACHABLE when called: this presses a real button
 * and does not wait out anything covering it. On the one path where something
 * does — a Guardian seed recovery, behind `HotKeyRotationGate` — the caller that
 * owns the rotation dismisses the prompt instead, and a call made too early
 * fails naming that (see {@link ROTATION_GATE_HINT}) rather than as an
 * anonymous actionability timeout.
 *
 * @returns true if the prompt was found and declined, false if it never appeared.
 */
export async function dismissTelemetryConsent(
  target: Page | TelemetryConsentCdpDriver,
  opts: DismissTelemetryConsentOptions = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? TELEMETRY_CONSENT_TIMEOUT_MS;

  // `locator` is on Playwright's `Page` and on nothing in the CDP drivers, so it
  // is the discriminant. No cast: `in` narrows the union.
  return 'locator' in target
    ? dismissViaLocators(target, timeoutMs, opts.nextSurface)
    : dismissViaCdp(target, timeoutMs, opts.nextSurface);
}

async function dismissViaLocators(page: Page, timeoutMs: number, nextSurface: string | undefined): Promise<boolean> {
  const prompt = page.locator(PROMPT_SELECTOR);
  const awaited = nextSurface ? prompt.or(page.locator(nextSurface)).first() : prompt;

  try {
    await awaited.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    // ONLY "nothing showed up in time" is tolerable here. A closed page, a
    // strict-mode violation or a crashed browser must not be laundered into a
    // silent no-op.
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }

  if (!(await prompt.isVisible())) return false;

  try {
    await prompt.locator(DECLINE_SELECTOR).click({ timeout: CONSENT_ACTION_TIMEOUT_MS });
  } catch (error) {
    // Re-checked on failure rather than guarded before the click: the gate can
    // mount in the window between the prompt becoming visible and the click
    // landing, so a pre-flight check would leave exactly this diagnosis missing
    // from the interleaving most likely to produce it. Costs nothing when the
    // click succeeds.
    if (error instanceof errors.TimeoutError && (await page.locator(ROTATION_GATE_SELECTOR).isVisible())) {
      throw new Error(`dismissTelemetryConsent: could not decline — ${ROTATION_GATE_HINT}`);
    }
    throw error;
  }
  // Declining navigates to `postOnboardingRoute()`, which unmounts the prompt.
  // Waiting for that means a caller resumes on the next screen rather than
  // mid-transition.
  await prompt.waitFor({ state: 'detached', timeout: CONSENT_ACTION_TIMEOUT_MS });
  return true;
}

async function dismissViaCdp(
  driver: TelemetryConsentCdpDriver,
  timeoutMs: number,
  nextSurface: string | undefined
): Promise<boolean> {
  // The mobile page objects' own `waitFor` throws when the selector never
  // appears, which is the one outcome that must NOT be an error here — hence
  // this poll rather than a try/catch around a message string. It is their own
  // `pollForSelector` idiom, at a short budget and answering with a boolean. An
  // `evalJs` rejection is a real transport failure and still propagates.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isMounted(driver, PROMPT_SELECTOR)) break;
    // Same race as the locator path: the flow having reached `nextSurface`
    // settles "there is no prompt" without waiting out the clock.
    if (nextSurface && (await isMounted(driver, nextSurface))) return false;
    if (Date.now() >= deadline) return false;
    await driver.delay(CDP_POLL_INTERVAL_MS);
  }

  await driver.click(`${PROMPT_SELECTOR} ${DECLINE_SELECTOR}`);

  const goneBy = Date.now() + CONSENT_ACTION_TIMEOUT_MS;
  while (await isMounted(driver, PROMPT_SELECTOR)) {
    if (Date.now() >= goneBy) {
      throw new Error(
        `dismissTelemetryConsent: "Not now" was clicked but ${PROMPT_SELECTOR} is still mounted after ` +
          `${CONSENT_ACTION_TIMEOUT_MS}ms`
      );
    }
    await driver.delay(CDP_POLL_INTERVAL_MS);
  }
  return true;
}

function isMounted(driver: TelemetryConsentCdpDriver, selector: string): Promise<boolean> {
  return driver.evalJs<boolean>(`return !!document.querySelector(${JSON.stringify(selector)});`);
}
