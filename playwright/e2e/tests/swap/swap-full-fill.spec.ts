import { expect, test } from '../../fixtures/two-wallets';
import { createSwapOrder, fillSwapOrder, fundSwapPair, readLineage, tokenBalance } from '../../helpers/swap';

/**
 * Scenario 3.1 — full fill, maker A → taker B.
 *
 * A offers 10 SWPA for 9 SWPB. B fills the entire 9 SWPB request. Asserts the
 * complete settlement: the taker fill lands, the maker order's on-chain lineage
 * goes `filled`, B receives the full offered SWPA, and A — after claiming the
 * P2ID payback — receives the full requested SWPB.
 *
 * OFFER = 10 SWPA (1_000_000_000 base units @ 8dp); REQUEST = 9 SWPB (900_000_000).
 */
test.describe('swap: full fill A→B', () => {
  test.describe.configure({ mode: 'serial' });

  const OFFER_BASE = '1000000000'; // 10 SWPA
  const REQUEST_BASE = '900000000'; // 9 SWPB

  test('A offers 10 SWPA for 9 SWPB, B fills fully; both sides settle', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    const a = await walletA.createNewWallet();
    const b = await walletB.createNewWallet();

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

    const fill = await fillSwapOrder({
      taker: walletB,
      takerAddress: b.address,
      maker: walletA,
      orderId,
      offer: pair.offer,
      request: pair.request,
      offerAmount: OFFER_BASE,
      requestAmount: REQUEST_BASE,
      fillAmount: REQUEST_BASE
    });
    expect(fill.ok, `taker fill failed: ${fill.error}`).toBe(true);

    // Settlement 1: maker order lineage is fully filled on-chain.
    await expect
      .poll(async () => (await readLineage(walletA, orderId)).state, { timeout: 90_000, intervals: [3000] })
      .toBe('filled');

    // Settlement 2: taker received the full offered SWPA.
    await expect
      .poll(async () => (await tokenBalance(walletB, b.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(OFFER_BASE);

    // Settlement 3: the swap lifecycle auto-consumes the hidden payback; the
    // generic Pending Notes / Claim All flow is not involved.
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.request.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(REQUEST_BASE);
  });
});
