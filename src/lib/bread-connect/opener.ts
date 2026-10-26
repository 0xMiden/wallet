import { registerPlugin } from '@capacitor/core';

interface BreadConnectOpenerPlugin {
  openCallback(options: { url: string }): Promise<{ opened: boolean }>;
}

const BreadConnectOpener = registerPlugin<BreadConnectOpenerPlugin>('BreadConnectOpener');

/**
 * Opens an app's callback link through verified-link routing only, so the answer reaches the app the callback's
 * domain names and never a browser. False when no app takes it.
 */
export async function openCallback(link: string): Promise<boolean> {
  try {
    return (await BreadConnectOpener.openCallback({ url: link })).opened;
  } catch (error) {
    console.warn('[bread-connect] openCallback failed:', error);
    return false;
  }
}
