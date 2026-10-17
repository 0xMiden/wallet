import type { Locator } from '@playwright/test';

// The small locator boundary also lets component tests exercise these drivers against rendered UI.
export interface ContactNetworkPage {
  getByTestId(id: string): Pick<Locator, 'isVisible' | 'waitFor' | 'textContent' | 'click'>;
}

export interface FieldNetwork {
  id: string;
  name: string;
}

export const SEPOLIA_NETWORK: FieldNetwork = { id: 'sepolia', name: 'Sepolia' };

/**
 * Picks `network` in the NetworkField whose test ids start with `prefix`: through its picker sheet while it offers a
 * choice, then checks that the closed summary names it; a field with one network only has its static row read.
 */
async function selectFieldNetwork(
  page: ContactNetworkPage,
  prefix: string,
  label: string,
  network: FieldNetwork,
  timeoutMs: number
): Promise<void> {
  const picker = page.getByTestId(`${prefix}-network-picker`);
  const row = page.getByTestId(`${prefix}-network-${network.id}`);
  const hasPicker = await picker.isVisible();
  if (hasPicker) await picker.click({ timeout: timeoutMs });

  await row.waitFor({ state: 'visible', timeout: timeoutMs });
  const shown = (await row.textContent())?.trim() ?? '';
  if (shown !== network.name) {
    throw new Error(
      `${label} network ${network.id} reads ${JSON.stringify(shown)}, expected ${JSON.stringify(network.name)}.`
    );
  }
  if (hasPicker) {
    await row.click({ timeout: timeoutMs });
    await row.waitFor({ state: 'hidden', timeout: timeoutMs });
    await picker.waitFor({ state: 'visible', timeout: timeoutMs });
    const selected = (await picker.textContent())?.trim() ?? '';
    if (selected !== network.name) {
      throw new Error(
        `${label} network selection stayed ${JSON.stringify(selected)}, expected ${JSON.stringify(network.name)}.`
      );
    }
  }
}

export function selectContactNetwork(
  page: ContactNetworkPage,
  network: FieldNetwork,
  timeoutMs: number
): Promise<void> {
  return selectFieldNetwork(page, 'add-contact', 'Contact', network, timeoutMs);
}

/** A 0x recipient's destination on the Send flow's recipient step. */
export async function selectSendNetwork(
  page: ContactNetworkPage,
  network: FieldNetwork,
  timeoutMs: number
): Promise<void> {
  // The field mounts once the typed address validates; until then the picker reads as absent.
  await page.getByTestId('send-network-options').waitFor({ state: 'visible', timeout: timeoutMs });
  await selectFieldNetwork(page, 'send', 'Send', network, timeoutMs);
}
