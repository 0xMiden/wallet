import type { Page } from '@playwright/test';

import { TELEMETRY_CONSENT_TESTID } from './telemetry-consent';

/** The Confirmation button is already on screen when it is tapped, so seconds are generous. */
const TAP_TIMEOUT_MS = 10_000;

/** Whether Confirmation needed a tap, or the flow moved on to the consent prompt or the handoff by itself. */
export type ImportConfirmationOutcome = 'tapped' | 'moved-on';

/**
 * Get a recovery-phrase import past onboarding's Confirmation step, called right after its
 * recovery method is submitted.
 *
 * On Chrome with the side panel the import registers by itself as soon as Confirmation appears
 * (a spinner with no button) and moves on to the consent prompt or the side-panel handoff, so
 * there is nothing to tap. A build without the side panel still waits on the Confirmation button.
 * The page says which of the two this run is, not a build flag: whichever of the button, the
 * prompt or the handoff screen shows first decides whether to tap.
 *
 * The Retry button a failed registration shows shares the button's testid, so pressing it also
 * reports `'tapped'`.
 */
export async function passImportConfirmation(page: Page, timeoutMs: number): Promise<ImportConfirmationOutcome> {
  const submit = page.getByTestId('onboarding-confirmation-submit');
  const movedOn = page.getByTestId(TELEMETRY_CONSENT_TESTID).or(page.getByTestId('finish-side-panel'));
  await submit.or(movedOn).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (!(await submit.isVisible())) return 'moved-on';
  await submit.click({ timeout: TAP_TIMEOUT_MS });
  return 'tapped';
}
