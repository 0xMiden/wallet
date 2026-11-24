import type { Page } from '@playwright/test';

export type EligibilityFixtureState = 'allowed' | 'restricted' | 'unavailable' | 'loading';

export function eligibilityFixtureUrl(): string {
  const url = new URL(process.env.FEATURE_ELIGIBILITY_URL ?? 'http://127.0.0.1:8551/v1/eligibility');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('E2E eligibility controls require the loopback fixture');
  }
  return url.origin;
}

export async function setEligibilityFixtureState(state: EligibilityFixtureState): Promise<void> {
  const response = await fetch(`${eligibilityFixtureUrl()}/_fixture/response`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state })
  });
  if (!response.ok) throw new Error(`Eligibility fixture state failed: ${response.status}`);
}

export async function resetEligibilityFixtureOrigin(): Promise<void> {
  const response = await fetch(`${eligibilityFixtureUrl()}/_fixture/origin`, { method: 'POST' });
  if (!response.ok) throw new Error(`Eligibility fixture Origin reset failed: ${response.status}`);
}

export async function getEligibilityFixtureOrigin(): Promise<{ observed: boolean; origin: string | null }> {
  const response = await fetch(`${eligibilityFixtureUrl()}/_fixture/origin`);
  if (!response.ok) throw new Error(`Eligibility fixture Origin read failed: ${response.status}`);
  const value: unknown = await response.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('observed' in value) ||
    typeof value.observed !== 'boolean' ||
    !('origin' in value) ||
    !(typeof value.origin === 'string' || value.origin === null)
  ) {
    throw new Error('Eligibility fixture Origin observation is invalid');
  }
  return { observed: value.observed, origin: value.origin };
}

/** All wallet realms and the decision endpoint must accept the same synthetic policy. */
export async function setEligibilityFixtureConfig<T extends {
  network: string;
  version: number;
}>(document: T): Promise<void> {
  const response = await fetch(`${eligibilityFixtureUrl()}/_fixture/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document)
  });
  if (!response.ok) throw new Error(`Eligibility fixture policy failed: ${response.status}`);
}

/** A new page then fetches the replacement fixture policy instead of hydrating the previous test's derivation. */
export async function forgetFixtureConfig(page: Page, network: string): Promise<void> {
  await page.evaluate(async networkName => {
    await chrome.storage.local.remove([`bridge_config_v1:${networkName}`, `bridge_config_derived_v2:${networkName}`]);
  }, network);
}
