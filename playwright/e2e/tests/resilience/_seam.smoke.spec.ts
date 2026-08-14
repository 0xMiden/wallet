import { expect, test } from '../../fixtures/two-wallets';

/**
 * Proves the whole-infra fault seam actually reaches NODE RPC traffic.
 *
 * Node gRPC-web runs in the extension's service worker and the SDK's
 * `web-client-methods-worker` (NOT as a routable page request), so
 * `context.route` can't touch it — it's faulted at the fetch layer
 * (harness/fetch-faults.ts + the wrapper in network-capture.ts), armed via
 * `walletA.armNetworkFault({ target: 'node', ... })`. If the seam didn't reach
 * those realms, arming a node fault would be a silent no-op and every downstream
 * resilience assertion would be meaningless (exactly the failure this smoke
 * caught during bring-up, before it was fixed).
 *
 * Account creation deploys the account and does its first sync — both REQUIRE
 * the node — so with the node fully refused it cannot complete: the seam
 * verifiably blocks a real node operation. (A post-onboarding sync is a weaker
 * probe: the SDK skips it once caught up, so it wouldn't reliably hit the node.)
 * That onboarding HANGS rather than surfacing a typed error under a node outage
 * is itself a resilience gap, covered by the onboarding scenario — not asserted
 * here; this smoke only proves the fault has a real effect.
 */
test.describe('network fault seam', () => {
  test('an armed node outage blocks a node-dependent operation', async ({ walletA }) => {
    await walletA.armNetworkFault({ target: 'node', mode: 'connectionRefused' });

    const outcome = await Promise.race([
      walletA
        .createNewWallet()
        .then(() => 'created')
        .catch(() => 'errored'),
      new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 20_000))
    ]);

    // Under a total node outage, account creation must NOT silently succeed —
    // the fault has to have reached the node path (blocking or erroring it).
    expect(outcome, 'node fault must reach and block account creation').not.toBe('created');
  });
});
