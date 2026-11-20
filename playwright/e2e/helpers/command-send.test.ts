/**
 * @jest-environment node
 */
import type { Page } from '@playwright/test';

import { commandSendForm, confirmCommandSendReview, openCommandSendDetails } from './command-send';

type FakeLocator = {
  id: string;
  visible: boolean;
  enabled: boolean;
  count: number;
  open?: boolean;
  click: jest.Mock;
  getByTestId(id: string): FakeLocator;
  locator(selector: string): FakeLocator;
};

jest.mock('@playwright/test', () => ({
  expect: (locator: FakeLocator) => ({
    toBeVisible: async () => {
      if (!locator.visible) throw new Error(`${locator.id} is not visible`);
    },
    toHaveCount: async (count: number) => {
      if (locator.count !== count) throw new Error(`${locator.id} has ${locator.count} matches`);
    },
    toBeEnabled: async () => {
      if (!locator.enabled) throw new Error(`${locator.id} is disabled`);
    },
    toHaveAttribute: async (name: string) => {
      if (name !== 'open' || !locator.open) throw new Error(`${locator.id} is closed`);
    }
  })
}));

function commandPage() {
  const nodes = new Map<string, FakeLocator>();
  const node = (id: string): FakeLocator => {
    let value = nodes.get(id);
    if (!value) {
      value = {
        id,
        visible: true,
        enabled: true,
        count: 1,
        click: jest.fn(async () => {
          if (id === 'summary') node('command-details').open = true;
        }),
        getByTestId: child => node(child),
        locator: selector => node(selector)
      };
      nodes.set(id, value);
    }
    return value;
  };
  node('send-recipient-confirm').count = 0;
  const page = {
    getByTestId: jest.fn(node),
    waitForURL: jest.fn(async () => undefined)
  } as unknown as Page;
  return { page, node };
}

it('accepts the explicit full-page Command form, then uses its real disclosure and footer', async () => {
  const { page, node } = commandPage();
  await expect(commandSendForm(page)).resolves.toBe(node('send-flow'));
  expect(node('send-recipient-input').visible).toBe(true);
  expect(node('send-amount-input').visible).toBe(true);
  await expect(openCommandSendDetails(page)).resolves.toBe(node('command-details'));
  expect(node('summary').click).toHaveBeenCalledTimes(1);
  await confirmCommandSendReview(page);
  expect(node('command-send-review').click).toHaveBeenCalledTimes(1);
  expect(page.waitForURL).toHaveBeenCalledWith(/#\/send\/review\?/, { timeout: 30_000 });
});

it('rejects a compact wizard in a full-page fixture even if its send-flow marker exists', async () => {
  const { page, node } = commandPage();
  node('command-shell').visible = false;
  await expect(commandSendForm(page)).rejects.toThrow('command-shell is not visible');
  expect(page.getByTestId).not.toHaveBeenCalledWith('send-flow');
});

it('never clicks or navigates if the guarded Command Review CTA is disabled', async () => {
  const { page, node } = commandPage();
  node('command-send-review').enabled = false;
  await expect(confirmCommandSendReview(page)).rejects.toThrow('command-send-review is disabled');
  expect(node('command-send-review').click).not.toHaveBeenCalled();
  expect(page.waitForURL).not.toHaveBeenCalled();
});
