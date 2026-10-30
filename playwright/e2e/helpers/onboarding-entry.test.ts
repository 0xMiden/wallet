import type { Page } from '@playwright/test';

import { openImportTypeScreen } from './onboarding-entry';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

function fakePage(inviteOnly: boolean) {
  const clicks: string[] = [];
  const visible = new Set(['#import-link']);
  function locator(id: string): unknown {
    const self = {
      waitFor: jest.fn(async () => {}),
      isVisible: async () => visible.has(id),
      or: (_other: unknown) => self,
      first: () => self,
      click: async () => {
        clicks.push(id);
        if (id === '#import-link')
          visible.add(inviteOnly ? 'import-select-type' : 'onboarding-network-notice-acknowledge');
        if (id === 'onboarding-network-notice-acknowledge') {
          visible.delete('onboarding-network-notice-acknowledge');
          visible.add('import-select-type');
        }
      }
    };
    return self;
  }
  return { clicks, page: { getByTestId: locator, locator } as unknown as Page };
}

it('opens recovery from invite-only Welcome without a network notice', async () => {
  const { clicks, page } = fakePage(true);
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['#import-link']);
});

it('keeps the existing test-network recovery and explicit notice acknowledgement', async () => {
  const { clicks, page } = fakePage(false);
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['#import-link', 'onboarding-network-notice-acknowledge']);
});
