import { expect, test } from '../../fixtures/two-wallets';
import { bridgeOutSlow, fundBridgeToken, readBridgedSendRows } from '../../helpers/bridge';
import { newEvmDestination } from '../../helpers/sepolia';

/**
 * Bridge-OUT, Slow (AggLayer) — real Miden testnet bridge-send, UI only.
 *
 * A funded Miden wallet bridges the dedicated bridgeable token to a fresh 0x
 * address via the Slow route. The wallet's REAL work is the Miden leg: build the
 * B2AGG note, prove it (delegated prover), submit it, and complete the
 * `bridged-send` row. That is what this asserts, end-to-end through the real Send
 * UI.
 *
 * The EVM-side settlement (an AggLayer relayer burns the B2AGG note into an L1
 * deposit; a separate external EVM wallet signs `claimAsset` against the real
 * AggLayer L1 contract) is 100% external AggLayer infra with NO hermetic double
 * — the row is already `Completed` before any EVM interaction — so faking it
 * would assert the fake, not wallet code. It is deliberately NOT covered here.
 *
 * The real AggLayer bridge faucet is a custom transfer-policy faucet the test
 * can't mint, so an E2E override (`__TEST_SET_AGGLAYER_FAUCET__`) points the Slow
 * route at a runtime-created test faucet (and flips the note's asset-callback
 * flag so the CLI-minted balance is found). Requires public Miden testnet + the
 * delegated prover, so this is testnet/nightly, not a per-PR gate.
 */
test.describe('bridge-out Miden to EVM (Slow AggLayer)', () => {
  test.describe.configure({ mode: 'serial' });

  const TOKEN_SYMBOL = 'AGG';
  const BRIDGE_AMOUNT = '1';

  // Funding (~150s) + Miden send/prove(delegated)/complete (~3m).
  test.setTimeout(600_000);

  test('bridges the AggLayer token to a 0x address; the Miden-side bridged-send row completes', async ({
    walletA,
    midenCli,
    timeline
  }) => {
    await walletA.createNewWallet();
    const { faucetHex } = await fundBridgeToken(midenCli, walletA, { symbol: TOKEN_SYMBOL, decimals: 6 }, timeline);

    const destination = newEvmDestination();

    await bridgeOutSlow(walletA, {
      destAddress: destination,
      tokenSymbol: TOKEN_SYMBOL,
      faucetHex,
      amount: BRIDGE_AMOUNT
    });

    // The Miden-side bridge-send is the wallet's real work: create + prove +
    // submit the B2AGG note. Poll the agglayer `bridged-send` row to Completed(2).
    await expect
      .poll(
        async () => {
          const row = (await readBridgedSendRows(walletA.page)).find(r => r.extraInputs?.provider === 'agglayer');
          return row?.status ?? null;
        },
        { timeout: 300_000, intervals: [3000] }
      )
      .toBe(2);

    const row = (await readBridgedSendRows(walletA.page)).find(r => r.extraInputs?.provider === 'agglayer');
    expect(row, 'agglayer bridged-send row exists').toBeTruthy();

    // A real Miden tx executed (not just a queued row): the B2AGG note committed
    // and a tx id was recorded.
    expect(row!.displayMessage, 'bridged-send label').toBe('Bridged to EVM');
    expect(row!.outputNoteIds?.length, 'exactly one B2AGG output note').toBe(1);
    expect(row!.transactionId, 'a real Miden tx id').toMatch(/^0x[0-9a-fA-F]+$/);

    // Negative guards against green-on-nothing:
    //  - the Slow route was actually taken (not the silent agglayer->epoch fallback);
    expect(row!.extraInputs?.provider, 'route = agglayer, not the epoch fallback').toBe('agglayer');
    //  - only the Miden leg is asserted; the EVM claim has not (and cannot here) happened.
    expect(row!.extraInputs?.claimStatus ?? 'pending', 'EVM L1 claim still pending').toBe('pending');
  });
});
