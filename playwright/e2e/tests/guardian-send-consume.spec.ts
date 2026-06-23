import { expect, test } from '../fixtures/two-wallets';

// Endpoint of the guardian spawned by the CI job (docker, GUARDIAN_NETWORK_TYPE
// matching E2E_NETWORK). Defaults to the local container's published port.
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

/**
 * End-to-end coverage for Guardian-backed accounts against a locally-spawned
 * guardian. Wallet A is a Guardian account: it is funded, consumes its incoming
 * notes (exercising the guardian consume-proposal path), and sends to a normal
 * wallet B (exercising the guardian send-proposal path). Both flows drive the
 * full ECDSA chain — wallet signs, guardian co-signs, multisig verifies on-chain
 * — which is the path unit tests can only mock.
 */
test.describe('Guardian account - consume + send', () => {
  test.describe.configure({ mode: 'serial' });

  test('guardian wallet A funds, consumes notes, and sends to wallet B', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    let addressA: string;
    let addressB: string;

    await steps.step('create_wallets', async () => {
      // A is Guardian-backed (points at the locally-spawned guardian); B is a
      // standard wallet acting as the send recipient.
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
      await midenCli.mint(addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_guardian_a',
      async () => {
        // Guardian accounts sync via the guardian (extra HTTP round-trips), so
        // give it a wider window than the standard-account specs.
        const balance = await walletA.waitForBalanceAbove(0, 180_000, timeline);
        expect(balance).toBeGreaterThan(0);
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step(
      'consume_notes_guardian_a',
      async () => {
        // Routes through generateGuardianTransaction → createConsumeNotesProposal.
        await walletA.claimAllNotes(180_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'send_guardian_a_to_b',
      async () => {
        // Routes through generateGuardianTransaction → createSendProposal.
        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: '500',
          tokenSymbol: 'TST',
          isPrivate: false
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_receipt_wallet_b',
      async () => {
        const balance = await walletB.waitForBalanceAbove(0, 180_000, timeline);
        expect(balance).toBeGreaterThan(0);
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );
  });
});
