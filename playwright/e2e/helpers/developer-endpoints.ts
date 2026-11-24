import type { Page } from '@playwright/test';

/** Developer Settings inputs, by the key in their test id (`dev-endpoint-<key>`). */
export type DeveloperEndpointFields = Partial<
  Record<
    | 'rpcUrl'
    | 'proverUrl'
    | 'noteTransportUrl'
    | 'faucetUrl'
    | 'faucetApiUrl'
    | 'explorerUrl'
    | 'guardianUrl'
    | 'feeFaucetId',
    string
  >
>;

/**
 * Store endpoints the way a developer does before onboarding: Developer Settings (seven taps on the Welcome logo),
 * the given fields typed over the build network's prefill, Save. Only a profile with no wallet yet gets the editable
 * form.
 *
 * Resolves once the service worker runs on them. Save waits at most 4 s for the service worker's reload
 * (`RELOAD_ENDPOINT_OVERRIDES_SW_TIMEOUT_MS`) and then moves on, so this sends the same request again and awaits
 * its answer: the account onboarding creates next must not land on the client the reload discards.
 */
export async function saveDeveloperEndpoints(
  wallet: { page: Page; extensionId: string },
  fields: DeveloperEndpointFields
): Promise<void> {
  const { page } = wallet;
  await page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/developer-settings`, {
    waitUntil: 'domcontentloaded'
  });
  const save = page.getByTestId('dev-endpoints-save');
  await save.waitFor({ timeout: 60_000 });
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) await page.getByTestId(`dev-endpoint-${key}`).fill(value);
  }
  await save.click();

  const left = await page
    .getByTestId('developer-settings')
    .waitFor({ state: 'detached', timeout: 30_000 })
    .then(
      () => true,
      () => false
    );
  if (!left) {
    const shown = await page
      .getByTestId('dev-endpoints-error')
      .textContent()
      .catch(() => null);
    throw new Error(`Developer Settings did not save the endpoints${shown ? `: "${shown}"` : ''}`);
  }

  await page.evaluate(async type => {
    const intercom: unknown = Reflect.get(window, '__TEST_INTERCOM__');
    const request: unknown =
      typeof intercom === 'object' && intercom !== null ? Reflect.get(intercom, 'request') : undefined;
    if (typeof request !== 'function') throw new Error('__TEST_INTERCOM__ is missing: build with MIDEN_E2E_TEST=true');
    await Reflect.apply(request, intercom, [{ type }]);
  }, 'RELOAD_ENDPOINT_OVERRIDES_REQUEST');
}
