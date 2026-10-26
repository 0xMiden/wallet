import type { Page } from '@playwright/test';

import { openImportTypeScreen } from './onboarding-entry';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

function fakePage(inviteOnly: boolean) {
  const clicks: string[] = [];
  const visible = new Set(inviteOnly ? ['onboarding-no-code'] : ['#import-link']);
  function locator(id: string): unknown {
    const self = {
      waitFor: jest.fn(async () => {}),
      isVisible: async () => visible.has(id),
      or: (_other: unknown) => self,
      first: () => self,
      click: async () => {
        clicks.push(id);
        if (id === '#import-link') visible.add('onboarding-network-notice-acknowledge');
        if (id === 'no-code-sheet-recover' || id === 'onboarding-network-notice-acknowledge') {
          visible.delete('onboarding-network-notice-acknowledge');
          visible.add('import-select-type');
        }
      }
    };
    return self;
  }
  return { clicks, page: { getByTestId: locator, locator } as unknown as Page };
}

it('uses real recovery through the no-code sheet on invite-only Welcome without a network notice', async () => {
  const { clicks, page } = fakePage(true);
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['onboarding-no-code', 'no-code-sheet-recover']);
});

it('keeps the existing test-network recovery and explicit notice acknowledgement', async () => {
  const { clicks, page } = fakePage(false);
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['#import-link', 'onboarding-network-notice-acknowledge']);
});
