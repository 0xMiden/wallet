import { expect, test } from '../../fixtures/two-wallets';

/**
 * Proves the whole-infra fault seam (harness/network-faults.ts, armed via
 * walletA.armNetworkFault) actually reaches NODE RPC traffic issued from the
 * extension's SERVICE WORKER — the same reason the guardian smoke exists, but
 * for the generalized network targets. If the seam didn't reach SW node
 * fetches, arming a node fault would be a silent no-op and every downstream
 * resilience assertion would be meaningless.
 *
 * With node RPC refused, the SW sync loop's calls fail; after the wallet's
 * consecutive-failure threshold it categorizes the outage as `node` in the
 * connectivity state machine (src/lib/miden/activity/connectivity-state.ts),
 * mirrored to chrome.storage at `miden-connectivity-state`. Reading that key
 * back proves the injected fault reached — and was observed by — the SW.
 */
import { CONNECTIVITY_STATE_KEY, type ConnectivityStateSnapshot } from 'lib/miden/activity/connectivity-state';

test.describe('network fault seam', () => {
  test('an armed node fault reaches the service worker and is categorized', async ({ walletA }) => {
    walletA.armNetworkFault({ target: 'node', mode: 'connectionRefused' });

    // Drive several sync attempts past the consecutive-failure breaker, then
    // read the mirrored connectivity state. Poll because the SW loop + breaker
    // take a few ticks to flip the category.
    const deadline = Date.now() + 60_000;
    let nodeIssue = false;
    while (Date.now() < deadline && !nodeIssue) {
      await walletA.triggerSync().catch(() => {});
      const storage = await walletA.dumpChromeStorage();
      const snap = storage[CONNECTIVITY_STATE_KEY] as ConnectivityStateSnapshot | undefined;
      nodeIssue = !!snap?.node?.active;
      if (!nodeIssue) await walletA.navigateHome().catch(() => {});
    }

    expect(nodeIssue, 'node connectivity issue should be flagged when node RPC is refused').toBe(true);

    // Disarm and confirm recovery: the next successful sync clears the category.
    walletA.clearFaults();
    await expect
      .poll(
        async () => {
          await walletA.triggerSync().catch(() => {});
          const storage = await walletA.dumpChromeStorage();
          const snap = storage[CONNECTIVITY_STATE_KEY] as ConnectivityStateSnapshot | undefined;
          return !!snap?.node?.active;
        },
        { timeout: 60_000, message: 'node connectivity issue should clear after the fault is removed' }
      )
      .toBe(false);
  });
});
