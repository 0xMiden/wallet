import { App } from '@capacitor/app';

import { callbackOrigin } from '@miden-sdk/bread-connect';

import { BreadConnectNative } from './plugin';
import { KeyValueStorage } from './storage';
import { AppSwitchTransport, LinkSource } from './transport';
import { BreadConnectWallet } from './wallet';

export { BreadConnectNative } from './plugin';
export type { BreadConnectPlugin } from './plugin';
export type { KeyValueStorage } from './storage';
export { AppSwitchTransport, BreadConnectError } from './transport';
export type { BreadConnectErrorCode, LinkSource, StoredSession, TransportOptions } from './transport';
export { BreadConnectWallet } from './wallet';

export interface BreadConnectOptions {
  /**
   * The app's https link for Bread's answers, for example `https://wherelegendsgrow.com/bread`. The app's
   * `apple-app-site-association` and `assetlinks.json` on that domain must give the link to the app.
   */
  callback: string;
  /** The name Bread shows next to the callback's origin. */
  appName: string;
  /** Where the session and the waiting request are kept; `localStorage` by default. */
  storage?: KeyValueStorage;
  /** The links the app is opened with; `@capacitor/app` by default. */
  links?: LinkSource;
  /** Opens Bread's link; the BreadConnect native plugin by default. */
  openWallet?: (link: string) => Promise<boolean>;
}

export function capacitorLinks(): LinkSource {
  return {
    launchUrl: async () => (await App.getLaunchUrl())?.url,
    onUrl: listener => {
      const handle = App.addListener('appUrlOpen', event => listener(event.url));
      return () => {
        void handle.then(listening => listening.remove());
      };
    }
  };
}

export async function openWithPlugin(link: string): Promise<boolean> {
  return (await BreadConnectNative.openWallet({ url: link })).opened;
}

/**
 * Makes Bread the app's `window.midenWallet`, which the stock Miden wallet adapter uses, so "Connect" and every
 * request switch to Bread and back. Call it once at startup in the native app only.
 */
export function installBreadConnect(options: BreadConnectOptions): BreadConnectWallet {
  if (callbackOrigin(options.callback) === null) {
    throw new Error('The callback must be a canonical https link on a domain the app owns, with no query or fragment');
  }
  const transport = new AppSwitchTransport({
    callback: options.callback,
    storage: options.storage ?? window.localStorage,
    links: options.links ?? capacitorLinks(),
    openWallet: options.openWallet ?? openWithPlugin
  });
  void transport.start();
  const wallet = new BreadConnectWallet(transport, options.appName);
  Object.defineProperty(window, 'midenWallet', { value: wallet, configurable: true, writable: true });
  return wallet;
}
