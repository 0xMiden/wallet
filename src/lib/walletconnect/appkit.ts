/**
 * Reown AppKit instance (dApp side).
 *
 * We're the dApp: AppKit owns the connect UX (wallet list, QR, mobile
 * deep-links) so we no longer hand-roll any of that. We use the Ethers
 * adapter purely to register the `eip155` namespace and expose the raw
 * EIP-1193 provider — the bridge layer (lib/epoch) feeds that provider to
 * viem's `custom()` transport, so `ethers` itself is never called directly.
 *
 * `createAppKit` runs once, lazily, the first time a browser context asks for
 * it. Lazy (vs. module-scope) keeps it out of the service-worker/SSR bundles,
 * which have no DOM for AppKit's web components.
 */
import { sepolia } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

import { APP_METADATA, WC_PROJECT_ID } from './config';

export type AppKitInstance = ReturnType<typeof createAppKit>;

let modal: AppKitInstance | null = null;

export function getModal(): AppKitInstance {
  if (typeof window === 'undefined') {
    throw new Error('AppKit can only be used in a browser context');
  }
  if (!WC_PROJECT_ID) {
    throw new Error('WALLETCONNECT_PROJECT_ID is not set');
  }
  if (!modal) {
    modal = createAppKit({
      adapters: [new EthersAdapter()],
      networks: [sepolia],
      projectId: WC_PROJECT_ID,
      metadata: APP_METADATA,
      // Pin MetaMask to the top of the wallet list. In the extension context
      // EIP-6963 injection doesn't fire (MetaMask only injects into web pages,
      // not extension pages), so without this it never surfaces as an option.
      featuredWalletIds: ['c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96'],
      // No analytics — avoids the extra pulse.walletconnect.org calls, which
      // keeps the extension CSP surface to just the relay we already allow.
      features: { analytics: false }
    });
  }
  return modal;
}
