import type { Runtime } from 'webextension-polyfill';

export function isExtensionPagePort(port: Pick<Runtime.Port, 'sender'>, extensionRoot: string, extensionId: string): boolean {
  return false;
}
