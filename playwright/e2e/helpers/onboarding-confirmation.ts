import type { Page } from '@playwright/test';

import { TELEMETRY_CONSENT_TESTID } from './telemetry-consent';

/**
 * Get a recovery-phrase import past onboarding's Confirmation step, called right after its
 * recovery method is submitted.
 *
 * Every caller runs a build with the side panel, where the import registers by itself as soon as
 * Confirmation appears (a spinner with no button) and moves on to the consent prompt or the
 * side-panel handoff (#1097), so this waits for either of those. A Confirmation button showing
 * first means the import did not auto-register, or the Retry of a failed auto-register (it shares
 * the button's testid), and fails the run at once: tapping it would pass the very regression
 * #1097 fixes.
 */
export async function passImportConfirmation(page: Page, timeoutMs: number): Promise<void> {
  const submit = page.getByTestId('onboarding-confirmation-submit');
  const movedOn = page.getByTestId(TELEMETRY_CONSENT_TESTID).or(page.getByTestId('finish-side-panel'));
  await submit.or(movedOn).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (await submit.isVisible()) {
    throw new Error(
      'passImportConfirmation: Confirmation shows its button instead of moving on, so the recovery did not ' +
        'auto-register on arrival (#1097), or its auto-register failed and this is the Retry button.'
    );
  }
}
