import { useEffect, useRef } from 'react';

import { isFiatRampEnabled } from 'lib/feature-flags';

import { useMidenContext } from './client';

const TICK_MS = 20_000;

/**
 * Headless fiat on-ramp watcher (same shape as `SwapSettlementManager`): polls
 * the MoonPay purchase status for the active buy session and the current
 * account's derived EVM address for the delivered token, then auto-bridges any
 * balance to Miden via AggLayer — no user interaction (gas comes from the
 * local paymaster).
 *
 * Deliberately mounted on EVERY platform, including the extension: unlike the
 * Miden-side managers there is no service-worker counterpart for EVM RPC (the
 * SW has no viem/EVM code), so popup-lifetime watching is the extension's
 * coverage. That's safe — each tick is idempotent (balance read + persistent
 * registry in `lib/fiat-ramp/buy-watcher`), so a torn-down popup just resumes
 * later.
 */
export function BuyBridgeManager(): null {
  const { currentAccount } = useMidenContext();
  const publicKey = currentAccount?.publicKey;
  const evmAddress = currentAccount?.evmAddress;
  const running = useRef(false);

  useEffect(() => {
    if (!publicKey || !evmAddress || !isFiatRampEnabled()) return;
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current) return;
      running.current = true;
      try {
        const { runBuyTick } = await import('lib/fiat-ramp/buy-watcher');
        await runBuyTick({ publicKey, evmAddress });
      } catch (err) {
        console.warn('[buy] watcher tick failed', err);
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = setInterval(tick, TICK_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [publicKey, evmAddress]);

  return null;
}
