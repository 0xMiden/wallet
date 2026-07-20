import { expect, test } from '../../fixtures/two-wallets';
import { createSwapOrder, fillSwapOrder, fundSwapPair, readLineage, tokenBalance } from '../../helpers/swap';

// Endpoint of the guardian spawned by the CI job / local stack (--profile
// guardian). Matches guardian-send-consume.spec.ts.
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

/**
 * Scenario 3.9 — swap from a Guardian (multisig) maker account.
 *
 * A is a Guardian-backed account (3-key auth, wallet signs + guardian co-signs
 * + multisig verifies on-chain); B is a standard taker. A offers 10 SWPA for 9
 * SWPB and B fills fully. This exercises the two guardian-co-signed legs the
 * standard-account scenarios can't: the `pswapCreate` that mints the maker note
 * and the P2ID payback claim. B's fill is a normal vault-signed consume.
 *
 * Guardian maker swaps DO work (this test passes end-to-end). A guardian maker's
 * public PSWAP note is published to the node's tag index exactly like a standard
 * maker's — the node publishes public output notes when the tx commits; there is
 * no account-type gate (verified empirically: an independent miden-client CLI
 * discovers the guardian note by tag, and by code inspection of the delivery
 * path). The one wrinkle is TAKER-SIDE and timing-only: the guardian's
 * canonicalization delays the note's commit, and the wallet SDK does not
 * back-fill a public note already committed in a past block when a taker
 * subscribes to its tag reactively. So this test uses the deterministic
 * maker->taker handoff (`maker: walletA` in fillSwapOrder: export the maker's
 * note, import it on the taker, consume by id) — timing-independent, and how the
 * standard fill scenarios run too. See docs/superpowers/plans/notes/R0-findings.md.
 */
test.describe('swap: guardian maker full fill', () => {
  test.describe.configure({ mode: 'serial' });

  const OFFER_BASE = '1000000000'; // 10 SWPA
  const REQUEST_BASE = '900000000'; // 9 SWPB

  test('guardian A offers 10 SWPA for 9 SWPB, B fills fully; both sides settle', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    // Guardian flows make many HTTP round-trips (create + co-signed pswapCreate +
    // co-signed payback claim) on top of funding + settlement polls. 12 min.
    test.setTimeout(720_000);

    const a = await walletA.createGuardianWallet(GUARDIAN_URL);
    const b = await walletB.createNewWallet();

    const pair = await fundSwapPair(
      midenCli,
      walletA,
      walletB,
      { offerSymbol: 'SWPA', requestSymbol: 'SWPB', balanceTimeoutMs: 220_000 },
      timeline
    );

    const orderId = await createSwapOrder(walletA, {
      offerSymbol: 'SWPA',
      requestSymbol: 'SWPB',
      payAmount: '10',
      receiveAmount: '9'
    });
    expect(orderId, 'guardian maker order id').not.toBe('');

    // Deterministic maker->taker note handoff (the taker imports the maker's
    // exported note and consumes by id), which is timing-independent — a
    // guardian maker's note commits with canonicalization delay, and the wallet
    // SDK does not back-fill a public note already committed in a past block when
    // a taker subscribes to its tag reactively.
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

    // Settlement 1: the guardian maker's order lineage is fully filled on-chain.
    await expect
      .poll(async () => (await readLineage(walletA, orderId)).state, { timeout: 120_000, intervals: [4000] })
      .toBe('filled');

    // Settlement 2: taker received the full offered SWPA.
    await expect
      .poll(async () => (await tokenBalance(walletB, b.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(OFFER_BASE);

    // Settlement 3: guardian maker claims the P2ID payback (guardian co-signs the
    // consume) and receives the full requested SWPB.
    await walletA.claimAllNotes(220_000);
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.request.faucetId)).toString(), {
        timeout: 120_000,
        intervals: [4000]
      })
      .toBe(REQUEST_BASE);
  });
});
