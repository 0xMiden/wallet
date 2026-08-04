import { useEffect, useRef } from 'react';

import { isDepositAddressBridgeEnabled } from 'lib/feature-flags';
import { useWalletStore } from 'lib/store';

import { useDepositAddressStore } from './store';

/**
 * Headless driver for the deposit-address watcher. Modeled on
 * `NativeNoteAutoConsumeManager`: one always-mounted interval, a `running` ref
 * against overlap, a `disposed` flag so a teardown mid-tick can't write, and an
 * early-out while the document is hidden (a background tab must not burn RPC).
 *
 * Extension caveat: this only runs while the popup/panel is open, so a deposit
 * that lands with the wallet closed is detected on the next open — acceptable
 * for v1 (the Cross-chain tab shows the balance regardless).
 */
const POLL_INTERVAL_MS = 12_000;

export function DepositAddressWatcher(): null {
  const evmAddress = useWalletStore(s => s.currentAccount)?.evmAddress;
  const setAddress = useDepositAddressStore(s => s.setAddress);
  const poll = useDepositAddressStore(s => s.poll);
  const running = useRef(false);

  useEffect(() => {
    setAddress(isDepositAddressBridgeEnabled() ? evmAddress : null);
  }, [evmAddress, setAddress]);

  useEffect(() => {
    if (!evmAddress || !isDepositAddressBridgeEnabled()) return;
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      running.current = true;
      try {
        await poll();
        if (disposed) return;
        // Advance any in-flight AggLayer deposit here too, so the progress page
        // moves without the user opening Activity (its usual reconcile driver).
        if (await hasLiveAgglayerBridgedReceive()) {
          const { reconcileAgglayerBridgedReceives } = await import('lib/miden/activity/bridge-receive');
          await reconcileAgglayerBridgedReceives();
        }
      } catch (err) {
        console.warn('[deposit-bridge] watcher tick failed', err);
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [evmAddress, poll]);

  return null;
}

const TERMINAL_RECEIVE_PHASES = new Set(['ready', 'received', 'failed']);

/** `extraInputs` is a union across row types — read it defensively, not by cast. */
function isLiveAgglayerReceive(extraInputs: unknown): boolean {
  if (!extraInputs || typeof extraInputs !== 'object') return false;
  const provider: unknown = Reflect.get(extraInputs, 'provider');
  const phase: unknown = Reflect.get(extraInputs, 'phase');
  return provider === 'agglayer' && typeof phase === 'string' && !TERMINAL_RECEIVE_PHASES.has(phase);
}

/**
 * Cheap gate on the reconcile import: the reconciler pulls the AggLayer indexer
 * + receipt clients, so it must not run on every tick of a wallet with no bridge
 * in flight.
 */
async function hasLiveAgglayerBridgedReceive(): Promise<boolean> {
  const Repo = await import('lib/miden/repo');
  const row = await Repo.transactions
    .filter(tx => tx.type === 'bridged-receive' && isLiveAgglayerReceive(tx.extraInputs))
    .first();
  return Boolean(row);
}
