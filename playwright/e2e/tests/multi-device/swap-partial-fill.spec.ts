import { expect, type GuardianAwareWalletPage, test } from '../../fixtures/multi-device';
import {
  expectNoFailedRows,
  requestBackupRefresh,
  setupSharedAccount,
  waitForBackupSettled
} from '../../helpers/multi-device';
import {
  ACTIVITY_PENDING_HASH,
  expectHeldPayback,
  expectTokenBalance,
  exportOrderNote,
  fundSwapDevices,
  leadingAmount,
  must,
  ownClaimsOfNote,
  PeerPaybackWatch,
  placeSwapOrder,
  readSwapLedger,
  readSwapReceipt,
  type PlacedOrder,
  type SwapClaimRow,
  type SwapDevices,
  type SyncNoteView,
  UNKNOWN_AMOUNT,
  waitForNoteGone,
  waitForObservedPayback,
  waitForPaybackClaim,
  waitForRemainderReclaim,
  waitForRestoredRows,
  waitForSwapReceipt
} from '../../helpers/multi-device-swap';
import { DEFAULT_FUND_AMOUNT, fillSwapOrder, readLineage } from '../../helpers/swap';

/**
 * A partial fill of an order that one device of a Guardian account placed (repo
 * CLAUDE.md, "One note, several devices": "Swap paybacks" and "Swap receipt on the
 * other devices").
 *
 * Device A places 10 SWPA for 9.995 SWPB with the one-hour expiry. Wallet C, another
 * account, fills 40%. The settlement claims the payback of an order that is still
 * open only when the order expires or the user cancels it
 * (`reconcileSwapOrderNotes`), so the remainder stays open and the payback stays
 * unclaimed until A presses Cancel. That gives a stable window to read:
 *
 * - Before the fill: A offers Cancel for its open order. B restores the order from
 *   A's backup, shows no fill and offers no Cancel (B has no lineage for it, and a
 *   restored order cannot be cancelled).
 * - After the fill, while the order is open and the payback unclaimed: B flags the
 *   payback as a peer payback, does not list it, does not record it as seen, and
 *   still shows no fill.
 * - A presses Cancel: A claims the payback and takes the remainder back. B makes
 *   no claim row, and after A's backup settles B shows the partial fill, the same
 *   as A.
 */
test.describe('Multi-device swap: partial fill', () => {
  const OFFER_BASE = 1_000_000_000n; // 10 SWPA at 8 decimals
  const REQUEST_BASE = 999_500_000n; // 9.995 SWPB: price 1, 5 bps slippage
  const FILL_BASE = 399_800_000n; // 40% of the request
  const PAID_OUT_BASE = 400_000_000n; // the taker's 4 SWPA for that fill
  const REMAIN_OFFER_BASE = 600_000_000n;
  const REMAIN_REQUEST_BASE = 599_700_000n;
  const FUNDED = BigInt(DEFAULT_FUND_AMOUNT);

  test('the placing device keeps a partial payback until Cancel; the other device holds it back and then shows the partial fill', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    timeline
  }) => {
    // Account setup, two faucets, the order, the fill, the Cancel and the backup take 14 to 20 minutes on testnet.
    test.setTimeout(30 * 60_000);

    let address = '';
    let devices: SwapDevices | undefined;
    let order: PlacedOrder | undefined;
    let watch: PeerPaybackWatch | undefined;
    let payback: SyncNoteView | undefined;
    let claim: SwapClaimRow | undefined;
    let reclaim: SwapClaimRow | undefined;

    await steps.step('create_on_a_and_add_b', async () => {
      address = (await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' })).address;
    });

    await steps.step('fund_offer_on_a_and_request_on_c', async () => {
      devices = await fundSwapDevices({ placing: walletA, taker: walletC, sharedAddress: address, midenCli, timeline });
    });

    await steps.step('a_places_the_order', async () => {
      const { pair } = must(devices, 'devices');
      order = await placeSwapOrder(walletA, pair, { payAmount: '10', receiveAmount: '9.995', expiry: '1h' });
      expect(order.expiresAt, 'the one-hour preset is stamped on the order').toBeGreaterThan(
        Math.floor(Date.now() / 1000) + 30 * 60
      );
    });

    await steps.step('a_offers_cancel_for_its_open_order', async () => {
      const onA = await waitForSwapReceipt(
        walletA,
        must(order, 'order').rowId,
        view => view.cancelOffered,
        'A offers Cancel while its order is open'
      );
      // A reads its own lineage, so it states a zero fill, where B can state none.
      expect(leadingAmount(onA.filled), 'nothing is filled yet').toBe(0);
    });

    await steps.step('b_restores_the_open_order_with_no_fill_and_no_cancel', async () => {
      const placed = must(order, 'order');
      await waitForBackupSettled(walletA, 180_000);
      await waitForRestoredRows(
        walletB,
        rows => rows.some(row => row.id === placed.rowId && row.restoredFromBackup),
        'B restores the order of A'
      );
      const onB = await readSwapReceipt(walletB, placed.rowId);
      expect(onB.filled, 'B shows no fill for an open order').toBe(UNKNOWN_AMOUNT);
      expect(onB.cancelOffered, 'B offers no Cancel for an order that A placed').toBe(false);
    });

    await steps.step('b_watches_its_pending_list', async () => {
      await walletB.navigateTo(ACTIVITY_PENDING_HASH);
      watch = new PeerPaybackWatch(walletB, must(devices, 'devices').pair.request.faucetId);
    });

    await steps.step('c_fills_part_of_the_order', async () => {
      const { pair, takerAddress } = must(devices, 'devices');
      const placed = must(order, 'order');
      const fill = await fillSwapOrder({
        taker: walletC,
        takerAddress,
        noteFileHex: await exportOrderNote(walletA, placed.orderId),
        orderId: placed.orderId,
        offer: pair.offer,
        request: pair.request,
        offerAmount: OFFER_BASE.toString(),
        requestAmount: REQUEST_BASE.toString(),
        fillAmount: FILL_BASE.toString()
      });
      expect(fill.ok, `the taker's partial fill failed: ${fill.error}`).toBe(true);
      await expect
        .poll(
          async () => {
            const lineage = await readLineage(walletA, placed.orderId);
            return `${lineage.state}:${lineage.remainingOffered}:${lineage.remainingRequested}`;
          },
          { message: 'the remainder stays open on A', timeout: 180_000, intervals: [4_000] }
        )
        .toBe(`active:${REMAIN_OFFER_BASE}:${REMAIN_REQUEST_BASE}`);
      await expectTokenBalance(walletC, takerAddress, pair.offer.faucetId, PAID_OUT_BASE, 'C receives its share');
    });

    await steps.step('b_holds_the_payback_back_while_the_order_is_open', async () => {
      const running = must(watch, 'watch');
      payback = await waitForObservedPayback(running, FILL_BASE.toString());
      await expect
        .poll(() => running.report().heldListSamples, {
          message: 'B reads its Pending list inside the hold',
          timeout: 120_000,
          intervals: [2_000]
        })
        .toBeGreaterThanOrEqual(3);
      const report = await running.stop();
      expectHeldPayback(report, payback.id, 3);
      // A settles the payback of an open order only at expiry or on Cancel.
      const linked = (await readSwapLedger(walletA)).claims.filter(
        row => row.swapOrderTxId === must(order, 'order').rowId
      );
      expect(linked, 'A has not claimed the payback of its open order').toEqual([]);
    });

    await steps.step('b_shows_no_fill_while_the_order_is_open', async () => {
      // A refresh brings nothing new: A has no claim of this order to upload yet.
      await requestBackupRefresh(walletB, 'foreground');
      const onB = await readSwapReceipt(walletB, must(order, 'order').rowId);
      expect(onB.filled, 'B shows no fill while the payback is unclaimed').toBe(UNKNOWN_AMOUNT);
      expect(onB.cancelOffered, 'B still offers no Cancel').toBe(false);
    });

    await steps.step('b_watches_its_pending_list_again', async () => {
      await walletB.navigateTo(ACTIVITY_PENDING_HASH);
      watch = new PeerPaybackWatch(walletB, must(devices, 'devices').pair.request.faucetId);
    });

    await steps.step('a_cancels_and_settles_the_order', async () => {
      const placed = must(order, 'order');
      const note = must(payback, 'payback');
      await waitForSwapReceipt(walletA, placed.rowId, view => view.cancelOffered, 'A still offers Cancel');
      await walletA.page.getByTestId('swap-cancel-order-button').click();
      await walletA.page.getByTestId('confirmation-modal-confirm').click();
      claim = await waitForPaybackClaim(walletA, placed.rowId);
      expect(claim.noteIds, 'the claim of A takes the payback that B saw').toContain(note.id);
      expect(claim.swapPaybackAmounts[note.id], 'A records what the payback paid').toBe(FILL_BASE.toString());
      reclaim = await waitForRemainderReclaim(walletA, placed.rowId);
      await expect
        .poll(async () => (await readLineage(walletA, placed.orderId)).state, { timeout: 180_000, intervals: [4_000] })
        .toBe('reclaimed');
    });

    await steps.step('b_held_the_payback_back_until_a_claimed_it', async () => {
      const note = must(payback, 'payback');
      await waitForNoteGone(walletB, note.id);
      expectHeldPayback(await must(watch, 'watch').stop(), note.id, 1);
    });

    await steps.step('balances_are_right_on_both_devices', async () => {
      const { pair, takerAddress } = must(devices, 'devices');
      const accountDevices: { wallet: GuardianAwareWalletPage; name: string }[] = [
        { wallet: walletA, name: 'A' },
        { wallet: walletB, name: 'B' }
      ];
      for (const { wallet, name } of accountDevices) {
        await expectTokenBalance(wallet, address, pair.request.faucetId, FILL_BASE, `${name}: one payback arrived`);
        await expectTokenBalance(
          wallet,
          address,
          pair.offer.faucetId,
          FUNDED - PAID_OUT_BASE,
          `${name}: only the filled share left, the remainder came back`
        );
      }
      await expectTokenBalance(walletC, takerAddress, pair.request.faucetId, FUNDED - FILL_BASE, 'C paid once');
    });

    await steps.step('the_payback_is_claimed_exactly_once', async () => {
      const noteId = must(payback, 'payback').id;
      const onA = ownClaimsOfNote(await readSwapLedger(walletA), noteId);
      expect(
        onA.filter(row => row.status === 'Completed').map(row => row.id),
        'A holds one completed claim of the payback'
      ).toEqual([must(claim, 'claim').id]);
      expect(
        onA.filter(row => row.status !== 'Completed'),
        'A holds no other claim of the payback'
      ).toEqual([]);
      expect(ownClaimsOfNote(await readSwapLedger(walletB), noteId), 'B made no claim of the payback').toEqual([]);
    });

    await steps.step('b_shows_the_partial_fill_from_the_backup', async () => {
      const placed = must(order, 'order');
      const claimRow = must(claim, 'claim');
      const reclaimRow = must(reclaim, 'reclaim');
      const noteId = must(payback, 'payback').id;
      await waitForBackupSettled(walletA, 180_000);
      await waitForRestoredRows(
        walletB,
        rows =>
          rows.some(row => row.id === claimRow.id && row.restoredFromBackup && row.status === 'Completed') &&
          rows.some(row => row.id === reclaimRow.id && row.restoredFromBackup && row.status === 'Completed'),
        'B restores the claim and the reclaim of A'
      );
      const restored = (await readSwapLedger(walletB)).claims.find(row => row.id === claimRow.id);
      expect(restored?.swapOrderTxId, 'the restored claim links to the order').toBe(placed.rowId);
      expect(restored?.swapPaybackAmounts[noteId], 'the backup carries what the payback paid').toBe(
        FILL_BASE.toString()
      );

      const known = (view: { filled: string }): boolean => view.filled !== UNKNOWN_AMOUNT;
      const onA = await waitForSwapReceipt(walletA, placed.rowId, known, 'A shows the partial fill');
      const onB = await waitForSwapReceipt(walletB, placed.rowId, known, 'B shows the partial fill from the backup');
      expect(onB.filled, 'B shows the same fill as A').toBe(onA.filled);
      expect(onB.total, 'B shows the same request as A').toBe(onA.total);
      expect(leadingAmount(onB.filled) ?? Number.POSITIVE_INFINITY, 'the fill on B is below the request').toBeLessThan(
        leadingAmount(onB.total) ?? 0
      );
      expect(onB.cancelOffered, 'B offers no Cancel').toBe(false);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
      await expectNoFailedRows(walletC);
    });
  });
});
