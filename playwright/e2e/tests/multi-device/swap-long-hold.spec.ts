import { expect, test } from '../../fixtures/multi-device';
import { expectNoFailedRows, setupSharedAccount, waitForHistoryRow } from '../../helpers/multi-device';
import {
  acceptPendingTransfer,
  ACTIVITY_PENDING_HASH,
  expectHeldPayback,
  expectTokenBalance,
  exportOrderNote,
  fundSwapDevices,
  HOLD_EDGE_SECONDS,
  holdEndsAt,
  must,
  ownClaimsOfNote,
  PeerPaybackWatch,
  pendingCard,
  placeSwapOrder,
  readSeenNoteIds,
  readSwapLedger,
  type PlacedOrder,
  type SwapDevices,
  type SyncNoteView,
  waitForObservedPayback
} from '../../helpers/multi-device-swap';
import { DEFAULT_FUND_AMOUNT, fillSwapOrder } from '../../helpers/swap';

/**
 * The placing device is closed when the fill lands (repo CLAUDE.md, "One note,
 * several devices", "Swap paybacks"): "with the placing device closed or lost ... no
 * device claims the payback unattended, so it must become a transfer to accept by
 * hand."
 *
 * Device A places 10 SWPA for 9.995 SWPB, gives the order note to the taker, and
 * its whole browser is then closed (`killBrowser`, so its service worker stops too
 * and cannot settle). Wallet C, another account, fills the order in full. Device B:
 *
 * - holds the payback back for `PEER_SWAP_PAYBACK_HOLD_SECONDS` after the payback's
 *   block (`receivedAt`, the block time, in `isHeldBackPeerSwapPayback`): no card
 *   on its Pending list, no seen-note record, no claim row;
 * - then lists it as a transfer to accept and records it as seen;
 * - the user accepts it by hand, and the balance is right.
 *
 * The hold is ten minutes of real time. This test runs only when
 * `E2E_MULTI_DEVICE_LONG_HOLDS=true`.
 */
test.describe('Multi-device swap: placing device closed', () => {
  test.skip(
    process.env.E2E_MULTI_DEVICE_LONG_HOLDS !== 'true',
    'Waits out the ten-minute peer-payback hold; set E2E_MULTI_DEVICE_LONG_HOLDS=true to run it'
  );

  const OFFER_BASE = 1_000_000_000n; // 10 SWPA at 8 decimals
  const REQUEST_BASE = 999_500_000n; // 9.995 SWPB: price 1, 5 bps slippage
  const FUNDED = BigInt(DEFAULT_FUND_AMOUNT);

  test('with the placing device closed, the other device lists the payback after the hold and the user accepts it', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    timeline
  }) => {
    // Account setup, funding and the order (about 15 minutes on testnet), the ten-minute hold, and the claim.
    test.setTimeout(45 * 60_000);

    let address = '';
    let devices: SwapDevices | undefined;
    let order: PlacedOrder | undefined;
    let noteFileHex = '';
    let watch: PeerPaybackWatch | undefined;
    let payback: SyncNoteView | undefined;

    await steps.step('create_on_a_and_add_b', async () => {
      address = (await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' })).address;
    });

    await steps.step('fund_offer_on_a_and_request_on_c', async () => {
      devices = await fundSwapDevices({ placing: walletA, taker: walletC, sharedAddress: address, midenCli, timeline });
    });

    await steps.step('a_places_the_order', async () => {
      order = await placeSwapOrder(walletA, must(devices, 'devices').pair, {
        payAmount: '10',
        receiveAmount: '9.995',
        expiry: '1h'
      });
    });

    await steps.step('a_hands_the_order_note_over_and_closes', async () => {
      // Exported before the close: the export reads the order note from the service worker of A.
      noteFileHex = await exportOrderNote(walletA, must(order, 'order').orderId);
      await walletA.killBrowser();
    });

    await steps.step('b_watches_its_pending_list', async () => {
      await walletB.navigateTo(ACTIVITY_PENDING_HASH);
      watch = new PeerPaybackWatch(walletB, must(devices, 'devices').pair.request.faucetId);
    });

    await steps.step('c_fills_the_order', async () => {
      const { pair, takerAddress } = must(devices, 'devices');
      const fill = await fillSwapOrder({
        taker: walletC,
        takerAddress,
        noteFileHex,
        orderId: must(order, 'order').orderId,
        offer: pair.offer,
        request: pair.request,
        offerAmount: OFFER_BASE.toString(),
        requestAmount: REQUEST_BASE.toString(),
        fillAmount: REQUEST_BASE.toString()
      });
      expect(fill.ok, `the taker's fill failed: ${fill.error}`).toBe(true);
      await expectTokenBalance(walletC, takerAddress, pair.offer.faucetId, OFFER_BASE, 'C receives the whole offer');
    });

    await steps.step('b_holds_the_payback_back_for_the_whole_hold', async () => {
      const running = must(watch, 'watch');
      const note = await waitForObservedPayback(running, REQUEST_BASE.toString());
      payback = note;
      const receivedAt = must(note.receivedAt, 'the receive time of the payback');
      const holdEnd = holdEndsAt(receivedAt);
      // Poll the Pending list itself until the card shows. The watch keeps sampling meanwhile and
      // records any card, seen-note record or claim row inside the hold.
      const waitMs = Math.max(0, holdEnd * 1000 - Date.now()) + 180_000;
      await expect(pendingCard(walletB, note.id), 'B lists the payback once the hold ends').toBeVisible({
        timeout: waitMs
      });
      const shownAt = Math.floor(Date.now() / 1000);
      const report = await running.stop();
      // About one sample per sync for ten minutes; 20 is a low floor that still proves the hold was read.
      expectHeldPayback(report, note.id, 20);
      const firstListedAt = report.firstListedAt[note.id] ?? shownAt;
      expect(firstListedAt, 'B lists the payback no earlier than the end of the hold').toBeGreaterThanOrEqual(
        holdEnd - HOLD_EDGE_SECONDS
      );
    });

    await steps.step('b_records_the_payback_as_seen_once_the_hold_ends', async () => {
      const noteId = must(payback, 'payback').id;
      await expect
        .poll(
          async () => {
            await walletB.triggerSync();
            return (await readSeenNoteIds(walletB)).has(noteId);
          },
          { message: 'the service worker records the payback once it may announce it', timeout: 120_000 }
        )
        .toBe(true);
    });

    await steps.step('b_accepts_the_payback_by_hand', async () => {
      const noteId = must(payback, 'payback').id;
      await acceptPendingTransfer(walletB, noteId);
      await waitForHistoryRow(
        walletB,
        row =>
          row.type === 'consume' &&
          !row.restoredFromBackup &&
          row.noteIds.includes(noteId) &&
          row.status === 'Completed',
        'the claim of B completes',
        300_000
      );
    });

    await steps.step('balance_is_right_and_the_payback_is_claimed_once', async () => {
      const { pair, takerAddress } = must(devices, 'devices');
      const noteId = must(payback, 'payback').id;
      await expectTokenBalance(walletB, address, pair.request.faucetId, REQUEST_BASE, 'B: the payback arrived once');
      await expectTokenBalance(walletB, address, pair.offer.faucetId, FUNDED - OFFER_BASE, 'B: the offer left');
      await expectTokenBalance(walletC, takerAddress, pair.request.faucetId, FUNDED - REQUEST_BASE, 'C paid once');
      const onB = ownClaimsOfNote(await readSwapLedger(walletB), noteId);
      expect(
        onB.map(row => row.status),
        'B holds exactly one claim of the payback, and it completed'
      ).toEqual(['Completed']);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletB);
      await expectNoFailedRows(walletC);
    });
  });
});
