import { expect, test } from '../fixtures/two-wallets';

const A = 'http://localhost:3000';
const B = 'http://localhost:3001';

/**
 * Guardian commitment (the on-chain `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` value)
 * for a given guardian operator, read straight from its own `GET
 * /pubkey?scheme=ecdsa` endpoint -- the same source `assertGuardianAuth`'s
 * `guardianCommitment` expectation is compared against (see the doc comment
 * on `assertGuardianAuth` in `helpers/wallet-page.ts`).
 */
async function guardianCommitment(endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}/pubkey?scheme=ecdsa`);
  if (!res.ok) {
    throw new Error(`guardianCommitment: GET ${endpoint}/pubkey?scheme=ecdsa failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { commitment: string };
  return body.commitment;
}

/**
 * Guardian switch happy path: an existing Guardian account (created + funded
 * against guardian A) switches its guardian to B, stays usable on B (both a
 * post-switch consume AND a send to a third wallet require B's
 * co-signature), and the switch survives a wallet close/reopen (extension
 * SW respawn) -- proving the new guardian is durably persisted per-account,
 * not just an in-memory artifact of the session that performed the switch.
 *
 * The design plan's naive assertion -- `assertGuardianAuth(pk, {signerCount:
 * 2, threshold: 2})` alone -- can NOT actually prove a switch happened:
 * signerCount/threshold describe the multisig's `[hot, cold]` signer set and
 * its `update_guardian` procedure threshold, and a guardian switch never
 * touches either -- only the SEPARATE guardian-commitment storage slot
 * changes. Every assertion below therefore also pins `guardianCommitment` to
 * the target guardian's real `/pubkey` commitment (asserted against A's
 * BEFORE the switch, and against B's after the switch and after reopen).
 *
 * The plan's "usable on B" step also called for a SELF-send, but the wallet
 * deliberately blocks that (`SendManager.tsx`'s `cannotSendToSelf` guard -- a
 * P2IDE-to-self doesn't consume cleanly through the note-script kernel), so
 * a self-send can never reach the send-review submit button. Sending to a
 * second, independent wallet (mirroring `guardian-send-consume.spec.ts`) is
 * both the only flow the product allows AND a strictly better usability
 * proof -- it's a real value transfer to a third party, not a same-account
 * round-trip.
 */
test.describe('Guardian switch - happy path + usability', () => {
  test('switch A to B: completes, usable on B, survives reopen', async ({ walletA, walletB, midenCli, steps }) => {
    // Guardian round-trips (create, switch, consume, send) each carry their
    // own multi-second canonicalization wait against the local guardian --
    // comfortable headroom over the base config's 300s default, mirroring
    // guardian-send-consume.spec.ts's budget for a similarly guardian-heavy
    // flow.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);
    const commitmentB = await guardianCommitment(B);
    expect(commitmentA, 'guardian A and B must be distinct operators for this test to mean anything').not.toBe(
      commitmentB
    );

    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_on_a_and_fund', async () => {
      const createdA = await walletA.createGuardianWallet(A);
      addressA = createdA.address;
      const createdB = await walletB.createNewWallet();
      addressB = createdB.address;

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);
    });

    await steps.step('verify_on_a_before_switch', async () => {
      // Baseline: freshly created, still on guardian A.
      await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
    });

    await steps.step(
      'switch_to_b',
      async () => {
        await walletA.switchGuardian(B);
        // The switch changes the guardian commitment while the signer set /
        // update_guardian threshold stay [hot,cold] / 2 -- this is the
        // assertion that actually proves the switch landed (see the
        // describe-level doc comment).
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'usable_on_b',
      async () => {
        // Consume-under-B: mint a fresh note AFTER the switch and drain it,
        // exercising createConsumeNotesProposal against the NEW guardian.
        await midenCli.mint(faucetId!, addressA!, 50_000_000_000, 'public');
        await midenCli.sync();
        await walletA.claimAllNotes(120_000);

        // Send-under-B: exercises createSendProposal against the NEW
        // guardian, and lands a real value transfer on a third wallet.
        await walletA.sendTokens({ recipientAddress: addressB!, amount: '10', isPrivate: false, tokenSymbol: 'TST' });
        const balanceB = await walletB.waitForBalanceAbove(0, 120_000);
        expect(balanceB).toBeGreaterThan(0);
      },
      {
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );

    await steps.step('close_and_reopen_still_on_b', async () => {
      await walletA.reopen(); // forces the extension's service worker to respawn
      await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      await expect(walletA.currentGuardianEndpoint()).resolves.toBe(B);
    });
  });
});
