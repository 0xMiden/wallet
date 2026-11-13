import type { Runtime } from 'webextension-polyfill';

import { isExtensionPagePort } from './extension-page';

const root = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const id = 'abcdefghijklmnopabcdefghijklmnop';
it.each<[Runtime.MessageSender | undefined, boolean]>([
  [{ id, url: root + 'sidepanel.html' }, true],
  [{ id, url: root + 'confirm.html' }, true],
  [{ id, url: 'https://example.com/' }, false],
  [{ id, url: root.replace(id, id + '.example.com') }, false],
  [{ id: 'other', url: root + 'sidepanel.html' }, false],
  [{ id }, false],
  [{ id, url: 'not a URL' }, false],
  [undefined, false]
])('authorizes only the extension page sender %#', (sender, allowed) => {
  expect(isExtensionPagePort({ sender }, root, id)).toBe(allowed);
});

it('preserves Firefox page authorization without enabling passkeys there', () => {
  expect(
    isExtensionPagePort(
      { sender: { id: 'wallet@example.com', url: 'moz-extension://uuid/options.html' } },
      'moz-extension://uuid/',
      'wallet@example.com'
    )
  ).toBe(true);
});
