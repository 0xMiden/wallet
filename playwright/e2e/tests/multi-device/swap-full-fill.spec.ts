import { expect, type GuardianAwareWalletPage, test } from '../../fixtures/multi-device';
import { expectNoFailedRows, setupSharedAccount, waitForBackupSettled } from '../../helpers/multi-device';
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
  type PlacedOrder,
  type SwapClaimRow,
  type SwapDevices,
  type SyncNoteView,
  UNKNOWN_AMOUNT,
  waitForNoteGone,
  waitForObservedPayback,
  waitForPaybackClaim,
  waitForRestoredRows,
  waitForSwapReceipt
} from '../../helpers/multi-device-swap';
import { DEFAULT_FUND_AMOUNT, fillSwapOrder, readLineage } from '../../helpers/swap';

/**
 * A full fill of an order that one device of a Guardian account placed, while that
 * device is open (repo CLAUDE.md, "One note, several devices": "Swap paybacks" and
 * "Swap receipt on the other devices").
 *
 * Device A places a PSWAP order: 10 SWPA for 9.995 SWPB. Wallet C, another account,
 * fills it and pays exactly the request. The taker cannot pay more: the SDK's fill
 * builder refuses a fill above the request ("Fill amount exceeds requested amount"),
 * so the unit tests of `swapReceipt.ts` cover a payback above the request.
 *
 * - A claims the payback unattended, exactly once.
 * - Device B, the other device of the account, flags the payback as a peer payback,
 *   does not list it on its Pending list, does not record it as seen, and makes no
 *   claim row for it. B never lists it, because A claims it inside the hold.
 * - The balance is right on both devices.
 * - Once A's backup settles and B refreshes, B's receipt shows the fill that the
 *   backup carries (`swapPaybackAmounts`), the same as A's receipt. B has no lineage
 *   for the order, so the backup is its only source of the fill.
 *
 * The expiry preset is one hour: on testnet the two-minute default can expire the
 * order before the fill lands. A full fill settles at once whatever the expiry.
 */
test.describe('Multi-device swap: full fill', () => {
  const OFFER_BASE = 1_000_000_000n; // 10 SWPA at 8 decimals
  const REQUEST_BASE = 999_500_000n; // 9.995 SWPB: price 1, 5 bps slippage
  const PAID_BASE = REQUEST_BASE; // the taker pays exactly the request
  const FUNDED = BigInt(DEFAULT_FUND_AMOUNT);

  test('the placing device claims the payback of a full fill; the other device holds it back and shows the fill from the backup', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    timeline
  }) => {
    // Account setup, two faucets, the order, the fill, the claim and the backup take 14 to 20 minutes on testnet.
    test.setTimeout(30 * 60_000);

    let address = '';
    let devices: SwapDevices | undefined;
    let order: PlacedOrder | undefined;
    let watch: PeerPaybackWatch | undefined;
    let payback: SyncNoteView | undefined;
    let claim: SwapClaimRow | undefined;

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

    await steps.step('b_watches_its_pending_list', async () => {
      const { pair } = must(devices, 'devices');
      await walletB.navigateTo(ACTIVITY_PENDING_HASH);
      watch = new PeerPaybackWatch(walletB, pair.request.faucetId);
    });

    await steps.step('c_fills_the_whole_order', async () => {
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
        fillAmount: PAID_BASE.toString()
      });
      expect(fill.ok, `the taker's fill failed: ${fill.error}`).toBe(true);
      await expect
        .poll(async () => (await readLineage(walletA, placed.orderId)).state, { timeout: 180_000, intervals: [4_000] })
        .toBe('filled');
      await expectTokenBalance(walletC, takerAddress, pair.offer.faucetId, OFFER_BASE, 'C receives the whole offer');
    });

    await steps.step('b_sees_a_peer_payback', async () => {
      payback = await waitForObservedPayback(must(watch, 'watch'), PAID_BASE.toString());
    });

    await steps.step('a_claims_the_payback_unattended', async () => {
      const note = must(payback, 'payback');
      claim = await waitForPaybackClaim(walletA, must(order, 'order').rowId);
      expect(claim.noteIds, 'the claim of A takes the payback that B saw').toContain(note.id);
      expect(claim.swapPaybackAmounts[note.id], 'A records what the payback paid').toBe(PAID_BASE.toString());
    });

    await steps.step('b_held_the_payback_back_until_a_claimed_it', async () => {
      const note = must(payback, 'payback');
      await waitForNoteGone(walletB, note.id);
      const report = await must(watch, 'watch').stop();
      expectHeldPayback(report, note.id, 3);
      expect(
        report.firstListedAt[note.id],
        'A claims inside the hold, so B never offers the payback to accept'
      ).toBeUndefined();
    });

    await steps.step('balances_are_right_on_both_devices', async () => {
      const { pair, takerAddress } = must(devices, 'devices');
      const accountDevices: { wallet: GuardianAwareWalletPage; name: string }[] = [
        { wallet: walletA, name: 'A' },
        { wallet: walletB, name: 'B' }
      ];
      for (const { wallet, name } of accountDevices) {
        await expectTokenBalance(wallet, address, pair.request.faucetId, PAID_BASE, `${name}: one payback arrived`);
        await expectTokenBalance(wallet, address, pair.offer.faucetId, FUNDED - OFFER_BASE, `${name}: the offer left`);
      }
      await expectTokenBalance(walletC, takerAddress, pair.request.faucetId, FUNDED - PAID_BASE, 'C paid once');
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

    await steps.step('b_shows_the_fill_from_the_backup', async () => {
      const placed = must(order, 'order');
      const claimRow = must(claim, 'claim');
      const noteId = must(payback, 'payback').id;
      await waitForBackupSettled(walletA, 180_000);
      await waitForRestoredRows(
        walletB,
        rows =>
          rows.some(row => row.id === placed.rowId && row.restoredFromBackup) &&
          rows.some(row => row.id === claimRow.id && row.restoredFromBackup && row.status === 'Completed'),
        'B restores the order and the claim of A'
      );
      const restored = (await readSwapLedger(walletB)).claims.find(row => row.id === claimRow.id);
      expect(restored?.restoredFromBackup, 'the claim on B is the one from the backup').toBe(true);
      expect(restored?.swapOrderTxId, 'the restored claim links to the order').toBe(placed.rowId);
      expect(restored?.swapPaybackAmounts[noteId], 'the backup carries what the payback paid').toBe(
        PAID_BASE.toString()
      );

      const known = (view: { filled: string }): boolean => view.filled !== UNKNOWN_AMOUNT;
      const onA = await waitForSwapReceipt(walletA, placed.rowId, known, 'A shows the fill');
      const onB = await waitForSwapReceipt(walletB, placed.rowId, known, 'B shows the fill from the backup');
      expect(onB.filled, 'B shows the same fill as A').toBe(onA.filled);
      expect(onB.total, 'B shows the same request as A').toBe(onA.total);
      // Two different fallbacks: an amount that does not parse can never read as equal.
      expect(leadingAmount(onB.filled) ?? Number.NaN, 'the fill on B is the whole request').toBe(
        leadingAmount(onB.total) ?? Number.POSITIVE_INFINITY
      );
      expect(onB.cancelOffered, 'B offers no Cancel for an order that A placed').toBe(false);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
      await expectNoFailedRows(walletC);
    });
  });
});
