import type { Locator } from '@playwright/test';

// The small locator boundary also lets component tests exercise this driver against rendered UI.
export interface ContactNetworkPage {
  getByTestId(id: string): Pick<Locator, 'isVisible' | 'waitFor' | 'textContent' | 'click'>;
}

export async function selectContactNetwork(
  page: ContactNetworkPage,
  network: { id: string; name: string },
  timeoutMs: number
): Promise<void> {
  const picker = page.getByTestId('add-contact-network-picker');
  const row = page.getByTestId(`add-contact-network-${network.id}`);
  const hasPicker = await picker.isVisible();
  if (hasPicker) await picker.click({ timeout: timeoutMs });

  await row.waitFor({ state: 'visible', timeout: timeoutMs });
  const label = (await row.textContent())?.trim() ?? '';
  if (label !== network.name) {
    throw new Error(
      `Contact network ${network.id} reads ${JSON.stringify(label)}, expected ${JSON.stringify(network.name)}.`
    );
  }
  if (hasPicker) {
    await row.click({ timeout: timeoutMs });
    await row.waitFor({ state: 'hidden', timeout: timeoutMs });
    await picker.waitFor({ state: 'visible', timeout: timeoutMs });
    const selected = (await picker.textContent())?.trim() ?? '';
    if (selected !== network.name) {
      throw new Error(
        `Contact network selection stayed ${JSON.stringify(selected)}, expected ${JSON.stringify(network.name)}.`
      );
    }
  }
}
