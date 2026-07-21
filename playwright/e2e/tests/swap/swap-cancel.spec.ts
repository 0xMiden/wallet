import { expect, test } from '../../fixtures/two-wallets';
import { cancelSwapOrder, createSwapOrder, fundSwapPair, readLineage, tokenBalance } from '../../helpers/swap';

/**
 * Scenario 3.4 — cancel / reclaim.
 *
 * A offers 10 SWPA for 9 SWPB and no one fills it. A cancels the order and
 * reclaims the offered asset. Asserts: creating the order locks the offered 10
 * SWPA out of A's vault, and cancelling restores it (order lineage → reclaimed,
 * A's SWPA balance back to the full funded amount).
 */
test.describe('swap: cancel + reclaim', () => {
  test.describe.configure({ mode: 'serial' });

  const FUNDED_BASE = '100000000000'; // fundSwapPair default (1000 SWPA @ 8dp)
  const AFTER_OFFER_BASE = '99000000000'; // funded - 10 SWPA offered

  test('A offers 10 SWPA, cancels unfilled; offered asset is reclaimed', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    const a = await walletA.createNewWallet();
    await walletB.createNewWallet();

    const pair = await fundSwapPair(
      midenCli,
      walletA,
      walletB,
      { offerSymbol: 'SWPA', requestSymbol: 'SWPB' },
      timeline
    );

    const orderId = await createSwapOrder(walletA, {
      offerSymbol: 'SWPA',
      requestSymbol: 'SWPB',
      payAmount: '10',
      receiveAmount: '9'
    });
    expect(orderId, 'maker order id').not.toBe('');

    // Creating the order locks the offered 10 SWPA out of A's vault.
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(AFTER_OFFER_BASE);

    const cancel = await cancelSwapOrder(walletA, orderId);
    expect(cancel.ok, `cancel failed: ${cancel.error}`).toBe(true);

    // Settlement 1: lineage reports the order reclaimed.
    await expect
      .poll(async () => (await readLineage(walletA, orderId)).state, { timeout: 90_000, intervals: [3000] })
      .toBe('reclaimed');

    // Settlement 2: the offered 10 SWPA is back in A's vault (claim covers a
    // note-based reclaim; a direct-credit reclaim leaves nothing to claim).
    await walletA.claimAllNotes(150_000);
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(FUNDED_BASE);
  });
});
