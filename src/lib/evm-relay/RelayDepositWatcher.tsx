import { useEffect } from 'react';

import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { fetchRelayDepositIntent } from './deposit-intent';

/**
 * Runs one deposit tick for the current account's intent when the wallet unlocks and when the document comes to the
 * foreground, so a deposit made while the wallet was closed is relayed without the deposit page. It renders nothing.
 * The backend engine runs one tick at a time per account and chain, so a tick here never overlaps the page's.
 */
export function RelayDepositWatcher(): null {
  const ready = useWalletStore(s => s.status === WalletStatus.Ready);
  const accountPublicKey = useWalletStore(s => s.currentAccount?.publicKey);
  const tick = useWalletStore(s => s.relayDepositTick);

  useEffect(() => {
    if (!ready || !accountPublicKey) return undefined;
    let cancelled = false;
    let running = false;
    const run = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        const intent = await fetchRelayDepositIntent(accountPublicKey);
        if (intent && !cancelled) await tick(accountPublicKey, intent);
      } catch (error) {
        console.warn('[relay-deposit-watcher] tick failed', error);
      } finally {
        running = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ready, accountPublicKey, tick]);

  return null;
}
