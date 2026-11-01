import type { Page } from '@playwright/test';

import { openImportTypeScreen } from './onboarding-entry';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

type Welcome = 'invite-only' | 'test-network' | 'invite-only before 1.17.10';

function fakePage(welcome: Welcome) {
  const clicks: string[] = [];
  const visible = new Set([
    'onboarding-welcome',
    welcome === 'invite-only before 1.17.10' ? 'onboarding-no-code' : '#import-link'
  ]);
  type Fake = { ids: string[] };
  function locator(...ids: string[]): Fake {
    const self = {
      ids,
      waitFor: async () => {
        if (!ids.some(id => visible.has(id))) throw new Error(`${ids.join(' or ')} not visible`);
      },
      isVisible: async () => ids.some(id => visible.has(id)),
      or: (other: Fake) => locator(...ids, ...other.ids),
      first: () => self,
      click: async () => {
        const id = ids[0] ?? '';
        if (!visible.has(id)) throw new Error(`${id} not visible`);
        clicks.push(id);
        if (id === '#import-link')
          visible.add(welcome === 'test-network' ? 'onboarding-network-notice-acknowledge' : 'import-select-type');
        if (id === 'onboarding-no-code') visible.add('no-code-sheet-recover');
        if (id === 'no-code-sheet-recover') visible.add('import-select-type');
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
  const { clicks, page } = fakePage('invite-only');
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['#import-link']);
});

it('keeps the existing test-network recovery and explicit notice acknowledgement', async () => {
  const { clicks, page } = fakePage('test-network');
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['#import-link', 'onboarding-network-notice-acknowledge']);
});

it('recovers through the no-code sheet on a release whose Welcome shows only the code options', async () => {
  const { clicks, page } = fakePage('invite-only before 1.17.10');
  await openImportTypeScreen(page);
  expect(clicks).toEqual(['onboarding-no-code', 'no-code-sheet-recover']);
});
