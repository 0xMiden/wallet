import { expect, test } from '../fixtures/two-wallets';
import { snapshotTransfer, type TransferSnapshot } from '../helpers/assertions';
import {
  fromBaseUnits,
  toBaseUnits,
  vaultBalance,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (the CLI takes base units).
const MINT_BASE_UNITS = 100_000_000_000n;
// What the send step transfers: the UI amount field takes a human amount.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

test.describe('Private Note Send', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens privately to wallet B via transport layer', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    let addressA: string;
    let addressB: string;
    // Both wallets' readings taken immediately before the send, so the receipt
    // step asserts a DELTA rather than a bare non-zero number.
    let beforeSend: TransferSnapshot;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
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

    await steps.step('sync_wallet_a', async () => {
      // Funding wait, made exact: the mint creates a NOTE, so its value is
      // UNCONSUMED until `claim_notes_wallet_a` runs — not spendable. Waiting
      // for exactly the minted amount fails if the wrong token, the wrong
      // amount, or nothing at all reached A; `> 0` on a vault+pending sum did not.
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Wallet A funded: ${fromBaseUnits(MINT_BASE_UNITS, TOKEN_DECIMALS)} ${TOKEN} unconsumed`,
        data: { symbol: TOKEN, pendingBaseUnits: MINT_BASE_UNITS.toString() }
      });
    });

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
      // The claim returns once the PENDING list reads empty twice — it does not wait
      // for the store's balances projection to catch up. Snapshotting before that
      // settles reads fromVault as 0n, making the sender-debit assertion below go
      // negative and fail a perfectly good run. Wait for the spendable vault to hold
      // the full claimed amount first. (Same guard send-public-local-prove uses.)
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'send_private_note_a_to_b',
      async () => {
        // Snapshot both sides first — the receipt assertion below is expressed as
        // "B's pending went up by exactly the sent amount and A's vault went down
        // by at least it", which needs the pre-send readings.
        beforeSend = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );

        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: SEND_AMOUNT,
          // Devnet's native MIDEN row (0 balance) now renders above the
          // CLI faucet's row — fee-asset discovery works on the 0.15 SDK —
          // so the default first-row click would pick the wrong token.
          tokenSymbol: TOKEN,
          isPrivate: true // Private payment toggle ON
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_receipt_wallet_b_via_transport',
      async () => {
        // Private notes are delivered via the note transport layer.
        // Wallet B syncs and discovers the private note automatically.
        //
        // DISCOVERS — it does not claim it: auto-consume only covers native MIDEN
        // notes (Explore.tsx filters on `faucetId === midenFaucetId`), so a TST
        // note stays UNCONSUMED. The delivery is therefore an exact PENDING total,
        // not a vault balance; asserting the vault here would fail on a working
        // wallet, and the old `> 0` on vault+pending passed for any amount of any
        // token from any source.
        await waitForPendingNoteTotal(walletB.page, TOKEN, beforeSend.toPending + SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Wallet B received private note: ${fromBaseUnits(SEND_BASE_UNITS, TOKEN_DECIMALS)} ${TOKEN} unconsumed`,
          data: { symbol: TOKEN, deliveredBaseUnits: SEND_BASE_UNITS.toString() }
        });

        // The other half of a transfer: A must actually have paid. "At least",
        // because a fee may also have left the account — but a credit to B with no
        // debit from A is a bug this now catches.
        const senderAfter = await vaultBalance(walletA.page, TOKEN);
        const debited = beforeSend.fromVault - senderAfter;
        expect(
          debited >= SEND_BASE_UNITS,
          `sender (A) must be debited by at least ${fromBaseUnits(SEND_BASE_UNITS, TOKEN_DECIMALS)} ${TOKEN}; ` +
            `was ${fromBaseUnits(beforeSend.fromVault, TOKEN_DECIMALS)} → ` +
            `${fromBaseUnits(senderAfter, TOKEN_DECIMALS)} (debited ${fromBaseUnits(debited, TOKEN_DECIMALS)})`
        ).toBe(true);
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
