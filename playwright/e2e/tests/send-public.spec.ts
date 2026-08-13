import { expect, test } from '../fixtures/two-wallets';
import { snapshotTransfer, type TransferSnapshot } from '../helpers/assertions';
import {
  fromBaseUnits,
  toBaseUnits,
  waitForPendingNoteTotal,
  waitForVaultBalance,
  waitForVaultDebit
} from '../helpers/balance-truth';
import {
  TxStatus,
  activityRowAddress,
  activityRowFor,
  openHistory,
  openHistoryDetails,
  readDetailRowFullValue,
  waitForSendRow
} from '../helpers/history';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (= 1000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// What the send step types into the amount field, and the same value in base units.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

test.describe('Public Note Send', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens publicly to wallet B', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    // Above the sum of the waits this test grants itself (600s of explicit
    // timeoutMs, plus the history tail's UI waits). Without this it runs under
    // the config's 300s default and can die on the test timeout BEFORE any of
    // its own waits expire — reporting a bare "Test timeout" instead of the
    // diagnostic the wait would have printed, which is a fake failure reason.
    test.setTimeout(900_000);
    let addressA: string;
    let addressB: string;
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
      await midenCli.mint(faucetId, addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        // Funding wait, made exact: the mint creates a NOTE, so its value is
        // UNCONSUMED until `claim_notes_wallet_a` runs — it is not spendable yet.
        // `> 0` on the vault+pending sum stayed true for a wrong amount, a wrong
        // token, or a note that never arrived.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

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
      'send_public_note_a_to_b',
      async () => {
        // Both sides' readings before the send, so the receipt step can assert a
        // DELTA rather than "B holds something".
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
        // B never claims in this spec, so the delivered public note is PENDING for
        // B, not spendable — the exact assertion is on the unconsumed-note total.
        // Asserting B's vault here would be wrong (it stays 0 without a claim), and
        // the old vault+pending `> 0` could not tell "500 TST arrived" apart from
        // "some dust of some token arrived".
        await waitForPendingNoteTotal(walletB.page, TOKEN, beforeSend.toPending + SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        // The other half of a transfer: A must actually have been debited. At least
        // the sent amount, not exactly it — a fee may also leave the account.
        // Waited, not read once: B's pending total moving proves the note is on-chain,
        // but A's own balances projection settles independently, so a bare read here
        // samples a vault that has not moved yet and reports `debited 0`.
        const debited = await waitForVaultDebit(walletA.page, TOKEN, beforeSend.fromVault, SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        const fromAfter = beforeSend.fromVault - debited;

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Public send verified: B credited exactly ${SEND_AMOUNT} ${TOKEN} as an unconsumed note, ` +
            `A debited ${fromBaseUnits(debited, TOKEN_DECIMALS)} ${TOKEN}`,
          data: {
            symbol: TOKEN,
            sentBaseUnits: SEND_BASE_UNITS.toString(),
            senderVaultBefore: beforeSend.fromVault.toString(),
            senderVaultAfter: fromAfter.toString(),
            recipientPendingBefore: beforeSend.toPending.toString()
          }
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

    // Rides the send above at zero extra chain cost: the balances are already
    // proven, so this asserts the wallet TELLS the user the same story its
    // balances do. Nothing in the suite opened #/history or #/history-details
    // before, so a row rendering the wrong amount or the wrong counterparty would
    // have shipped unnoticed.
    await steps.step(
      'verify_activity_history_wallet_a',
      async () => {
        // A's own row completing is a DIFFERENT signal from B's delivery — the
        // "Tx ID" row is conditional on `tx.transactionId`, which only exists
        // once completion stamps the on-chain hash. Waiting on the row (not on a
        // sleep) is what makes the detail-page assertions below deterministic.
        // 60s, not more: `waitForVaultDebit` above already observed A's debit, so
        // completion has landed and this is one poll away from resolving. A longer
        // budget here only pushes the spec further past its own test timeout.
        const sendRow = await waitForSendRow(walletA.page, {
          recipient: addressB!,
          amountBaseUnits: SEND_BASE_UNITS,
          status: TxStatus.Completed,
          requireTransactionId: true,
          timeoutMs: 60_000
        });

        await openHistory(walletA);

        // The truncated recipient is the only text on the row unique to one
        // counterparty, so it identifies the row; `activityRowFor` enforces a
        // single match so a two-row filter cannot silently assert on the first.
        const row = await activityRowFor(walletA.page, addressB!);
        await expect(row.getByTestId('activity-row-title')).toHaveText('Sent');
        await expect(row.getByTestId('activity-row-subtitle')).toHaveText(`To: ${activityRowAddress(addressB!)}`);
        // Exact, signed, with the symbol: `-500 TST`. A row that showed the
        // right number of the WRONG token reads identically without the symbol.
        await expect(row.getByTestId('activity-row-amount')).toHaveText(`-${SEND_AMOUNT} ${TOKEN}`);
        await expect(row.getByTestId('activity-row-status')).toHaveText('Confirmed');

        // A transaction has TWO ids and the detail page renders one of each: the
        // route param is the Dexie row uuid (`tx.id`), the "Tx ID" row is the
        // on-chain hash (`tx.transactionId`). This is a FIELD-MAPPING assertion,
        // not a chain-provenance one — nothing here asks the node what hash the
        // send really got. What it catches is the mapping regressing to a value
        // the user cannot look up on an explorer: the row uuid, a note id, or
        // another row's hash (`HistoryDetails` builds `externalTxId` from the row
        // it loaded by route param, and all four are hex-ish strings that look
        // interchangeable on screen).
        await openHistoryDetails(walletA, sendRow.id);
        const shownHash = await readDetailRowFullValue(walletA.page, 'history-detail-tx-id');
        expect(shownHash).toBe(sendRow.transactionId);
        expect(shownHash).not.toBe(sendRow.id);

        // The "To" row carries the untruncated recipient behind its copy field.
        // Unlike the hash, this IS checked against an independent source: wallet
        // B's own address, as B reported it at creation.
        const shownTo = await readDetailRowFullValue(walletA.page, 'history-detail-to');
        expect(shownTo).toBe(addressB!);
        await expect(walletA.page.getByTestId('history-status-pill')).toHaveText('Confirmed');

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Activity row and transaction detail agree with the send: -${SEND_AMOUNT} ${TOKEN} to ${activityRowAddress(addressB!)}, hash ${shownHash}`,
          data: { rowId: sendRow.id, transactionId: shownHash, recipient: addressB! }
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
