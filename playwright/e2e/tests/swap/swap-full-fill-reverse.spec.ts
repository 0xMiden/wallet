import { expect, test } from '../../fixtures/two-wallets';
import { createSwapOrder, fillSwapOrder, fundSwapPair, readLineage, tokenBalance } from '../../helpers/swap';

/**
 * Scenario 3.2 — full fill, maker B → taker A (the reverse direction of 3.1).
 *
 * Proves the maker/taker flow is symmetric: B is the maker (offers 10 SWPB for
 * 9 SWPA) and A is the taker (fills the full 9 SWPA). Same complete-settlement
 * assertions as 3.1 with the roles swapped.
 */
test.describe('swap: full fill B→A', () => {
  test.describe.configure({ mode: 'serial' });

  const OFFER_BASE = '1000000000'; // 10 SWPB (B offers)
  const REQUEST_BASE = '900000000'; // 9 SWPA (B requests)

  test('B offers 10 SWPB for 9 SWPA, A fills fully; both sides settle', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    const a = await walletA.createNewWallet();
    const b = await walletB.createNewWallet();

    // maker = B, taker = A: B funded with the offered SWPB, A with the requested SWPA.
    const pair = await fundSwapPair(
      midenCli,
      walletB,
      walletA,
      { offerSymbol: 'SWPB', requestSymbol: 'SWPA' },
      timeline
    );

    const orderId = await createSwapOrder(walletB, {
      offerSymbol: 'SWPB',
      requestSymbol: 'SWPA',
      payAmount: '10',
      receiveAmount: '9'
    });
    expect(orderId, 'maker order id').not.toBe('');

    const fill = await fillSwapOrder({
      taker: walletA,
      takerAddress: a.address,
      maker: walletB,
      orderId,
      offer: pair.offer,
      request: pair.request,
      offerAmount: OFFER_BASE,
      requestAmount: REQUEST_BASE,
      fillAmount: REQUEST_BASE
    });
    expect(fill.ok, `taker fill failed: ${fill.error}`).toBe(true);

    // Settlement 1: maker (B) order lineage is fully filled on-chain.
    await expect
      .poll(async () => (await readLineage(walletB, orderId)).state, { timeout: 90_000, intervals: [3000] })
      .toBe('filled');

    // Settlement 2: taker A received the full offered SWPB.
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(OFFER_BASE);

    // Settlement 3: maker B's hidden payback is consumed by the swap lifecycle.
    await expect
      .poll(async () => (await tokenBalance(walletB, b.address, pair.request.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(REQUEST_BASE);
  });
});
