import { expect, test } from '../../fixtures/two-wallets';
import {
  createSwapOrder,
  fillSwapOrder,
  fundSwapPair,
  readLineage,
  readMakerTag,
  tokenBalance
} from '../../helpers/swap';

/**
 * Scenario 3.3 — partial fill + remainder.
 *
 * A offers 10 SWPA for 10 SWPB (1:1 so proportions stay whole). B fills only 4
 * SWPB. Asserts the partial-swap mechanics: B receives the proportional 4 SWPA,
 * A gets a 4-SWPB payback, and the order lineage stays `active` carrying a
 * remainder of 6 SWPA offered / 6 SWPB requested.
 */
test.describe('swap: partial fill + remainder', () => {
  test.describe.configure({ mode: 'serial' });

  const OFFER_BASE = '1000000000'; // 10 SWPA
  const REQUEST_BASE = '1000000000'; // 10 SWPB
  const FILL_BASE = '400000000'; // 4 SWPB
  const PROP_OFFER_BASE = '400000000'; // 4 SWPA (4/10 * 10)
  const REMAIN_BASE = '600000000'; // 6 of each

  test('A offers 10 SWPA for 10 SWPB, B fills 4; proportional settle + active remainder', async ({
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
      receiveAmount: '10'
    });
    expect(orderId, 'maker order id').not.toBe('');

    const tagU32 = await readMakerTag(walletA);

    const fill = await fillSwapOrder({
      taker: walletB,
      takerAddress: b.address,
      orderId,
      offer: pair.offer,
      request: pair.request,
      offerAmount: OFFER_BASE,
      requestAmount: REQUEST_BASE,
      fillAmount: FILL_BASE,
      tagU32
    });
    expect(fill.ok, `taker partial fill failed: ${fill.error}`).toBe(true);

    // Settlement 1: order stays active with the correct remainder on both legs.
    await expect
      .poll(
        async () => {
          const l = await readLineage(walletA, orderId);
          return `${l.state}:${l.remainingOffered}:${l.remainingRequested}`;
        },
        { timeout: 90_000, intervals: [3000] }
      )
      .toBe(`active:${REMAIN_BASE}:${REMAIN_BASE}`);

    // Settlement 2: taker received the proportional 4 SWPA.
    await expect
      .poll(async () => (await tokenBalance(walletB, b.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(PROP_OFFER_BASE);

    // Settlement 3: maker claims the P2ID payback and receives the 4 SWPB paid so far.
    await walletA.claimAllNotes(150_000);
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.request.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(FILL_BASE);
  });
});
