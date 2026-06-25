import { expect, test } from '../fixtures/two-simulators';

/**
 * iOS port of the Chrome guardian-send-consume spec. Wallet A is Guardian-backed
 * (created via the onboarding bypass with walletType=guardian → the network
 * default guardian endpoint, which on devnet is guardian-stg). It is funded,
 * consumes its incoming notes (guardian consume-proposal path), and sends to a
 * standard wallet B (guardian send-proposal path). Both flows drive the full
 * co-sign chain — wallet signs, guardian co-signs, multisig verifies on-chain —
 * in the mobile WKWebView (single-threaded SDK + delegated proving), which the
 * Chrome guardian spec can't cover.
 *
 * iOS divergences from the Chrome spec (same as the other *.ios specs):
 *  - getBalance doesn't count pending notes, so each wallet claims explicitly
 *    before its balance is checked.
 *  - claimAllNotes is passed the custom faucetId so the iOS POM can pre-inject
 *    synthetic metadata (the SDK's metadata RPC fails for this faucet layout).
 */
test.describe('Guardian account - consume + send', () => {
  test.describe.configure({ mode: 'serial' });

  test('guardian wallet A funds, consumes notes, and sends to wallet B', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_wallets', async () => {
      // A is Guardian-backed (uses the network default guardian endpoint);
      // B is a standard private wallet acting as the send recipient.
      const a = await walletA.createGuardianWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      expect(faucetId).toBeTruthy();
      await midenCli.mint(addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'consume_notes_guardian_a',
      async () => {
        // Routes through generateGuardianTransaction → createConsumeNotesProposal.
        await walletA.claimAllNotes(180_000, [faucetId!]);
      },
      {
        captureStateFrom: [{ target: walletA, label: 'A' }],
      }
    );

    await steps.step(
      'verify_balance_guardian_a',
      async () => {
        const balance = await walletA.waitForBalanceAbove(0, 180_000, timeline);
        expect(balance).toBeGreaterThan(0);
      },
      {
        captureStateFrom: [{ target: walletA, label: 'A' }],
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
          isPrivate: false,
        });
      },
      {
        captureStateFrom: [{ target: walletA, label: 'A' }],
      }
    );

    await steps.step('claim_wallet_b', async () => {
      await walletB.claimAllNotes(180_000, [faucetId!]);
    });

    await steps.step(
      'verify_receipt_wallet_b',
      async () => {
        const balance = await walletB.waitForBalanceAbove(0, 180_000, timeline);
        expect(balance).toBeGreaterThan(0);
      },
      {
        captureStateFrom: [
          { target: walletA, label: 'A' },
          { target: walletB, label: 'B' },
        ],
      }
    );
  });
});
