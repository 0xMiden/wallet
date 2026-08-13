import { expect, test } from '../fixtures/two-wallets';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';

// Endpoint of the guardian spawned by the CI job (docker, GUARDIAN_NETWORK_TYPE
// matching E2E_NETWORK). Defaults to the local container's published port.
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to guardian wallet A below, in base units (the CLI takes base units).
const MINT_BASE_UNITS = 100_000_000_000n;
// Typed into the send form, so a human amount; its base-unit value is what the
// recipient must be credited.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

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
    // The full guardian flow (account creation + co-signed consume + co-signed
    // send) makes many HTTP round-trips to the guardian backend, each with its
    // own multi-second canonicalization wait, on top of three 180s balance
    // budgets — more than the default 5-min per-test cap. 10 min is comfortable
    // headroom against the CI-spawned local guardian (a hosted/remote guardian
    // is materially slower and may still exceed this).
    test.setTimeout(600_000);

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
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_guardian_a',
      async () => {
        // Guardian accounts sync via the guardian (extra HTTP round-trips), so
        // give it a wider window than the standard-account specs.
        //
        // The mint creates a NOTE: at this point it is discovered but NOT yet
        // consumed (the consume step below is what makes it spendable), so the
        // truthful reading is the UNCONSUMED total for TST, and it must equal the
        // exact minted amount. The old `> 0` on a vault+pending sum stayed true
        // for a wrong amount, a different token, or a note that never landed.
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Waiting for guardian wallet A to discover exactly ${MINT_BASE_UNITS} base units of ${TOKEN}`,
          data: { symbol: TOKEN, expectedUnconsumedBaseUnits: MINT_BASE_UNITS.toString() }
        });
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step('verify_guardian_auth_structure_a', async () => {
      // First on-chain AUTH assertion in the harness (balance checks can't see
      // this): a fresh 3-key Guardian account must carry two signers ([hot,
      // cold]) and the `update_guardian` procedure hardened to threshold 2 —
      // both set at creation. The same reader verifies the migrated/activated
      // path in the (P1) migration spec.
      const auth = await walletA.getGuardianAuthInfo(addressA!);
      expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
      expect(auth.signerCommitments.length, 'fresh 3-key account should have 2 signers (hot, cold)').toBe(2);
      expect(auth.procedureThresholds.update_guardian, 'update_guardian must be hardened to threshold 2').toBe(2);
    });

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
          amount: SEND_AMOUNT,
          tokenSymbol: TOKEN,
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
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Waiting for wallet B to be credited exactly ${SEND_BASE_UNITS} base units of ${TOKEN}`,
          data: {
            symbol: TOKEN,
            expectedRecipientUnconsumedBaseUnits: SEND_BASE_UNITS.toString(),
            expectedSenderVaultBaseUnits: (MINT_BASE_UNITS - SEND_BASE_UNITS).toString()
          }
        });

        // Recipient side. The send delivers a NOTE, and B never claims it in this
        // spec, so the truthful reading for B is the UNCONSUMED total — and it
        // must be exactly what A sent. Asserting B's VAULT here would be wrong
        // (it stays 0 until B consumes), and the old vault+pending `> 0` could
        // not tell 500 TST from 5 TST, from a note of some other token, or from
        // a note that arrived without the guardian ever co-signing the send.
        await waitForPendingNoteTotal(walletB.page, TOKEN, SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        // Sender side — the half a recipient-only check cannot see. Both guardian
        // paths under test are pinned by this one number: the co-signed CONSUME
        // must have moved the whole mint into A's spendable vault, and the
        // co-signed SEND must have debited it by exactly the sent amount, so A's
        // vault has to settle at mint − sent. A consume that leaves the note
        // pending, or a send that credits B without debiting A, fails here.
        // Exact (rather than the "debited by at least" form the transfer helper
        // uses) is safe because a Miden fee is charged in the NATIVE asset, never
        // in TST — these accounts hold no native balance at all, so nothing but
        // the send itself can move A's TST.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
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
