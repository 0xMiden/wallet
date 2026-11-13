import type { Runtime } from 'webextension-polyfill';

export function isExtensionPagePort(
  port: Pick<Runtime.Port, 'sender'>,
  extensionRoot: string,
  extensionId: string
): boolean {
  const sender = port.sender;
  if (sender?.id !== extensionId || typeof sender.url !== 'string') return false;
  try {
    const expected = new URL(extensionRoot);
    const actual = new URL(sender.url);
    return (
      ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(expected.protocol) &&
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.username === '' &&
      actual.password === ''
    );
  } catch {
    return false;
  }
}
