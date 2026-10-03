import { MIDEN_AGGLAYER_FAUCET_ID } from '../../../../src/lib/agglayer/b2agg/constant';
import { expect, test } from '../../fixtures/two-wallets';
import {
  allowAgglayerFaucetForE2E,
  backToAmountStep,
  confirmAmountStep,
  expectRegistryApproves,
  expectSlowRouteUnsupported,
  fundBridgeToken,
  openRouteStep,
  readBridgedSendRows,
  selectSlowAndSubmit
} from '../../helpers/bridge';
import { napiExitTxHashFromRequestBytes } from '../../helpers/exit-hash';
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
 * can't mint, so the test bridges a runtime-created faucet token instead. The
 * bridge registry does not list that faucet, so the spec first asserts the route
 * step refuses it on the real registry, then allowlists it through the E2E-only
 * page hook and bridges it through the real route step, review and submit. The
 * allowlist lives in the page's memory, so the spec steps back to the amount
 * step and confirms again (a fresh route step checks again) instead of reloading,
 * which would drop it; a same-hash goto would not reset the flow's steps either.
 * Before any of that, the bridge's own faucet must read as approved, so the
 * registry's approving answer is checked against a real node as well as its refusal.
 * Requires public Miden testnet + the delegated prover, so this is
 * testnet/nightly, not a per-PR gate.
 */
test.describe('bridge-out Miden to EVM (Slow AggLayer)', () => {
  test.describe.configure({ mode: 'serial' });

  // The header's "requires public Miden testnet" was prose only, so this ran against a local
  // chain and spent six minutes failing deep in the kernel with
  //   before_foreign_load -> account 0xa22ec1... not found at block N
  // because the real AggLayer bridge account it loads as a FOREIGN account exists only on
  // testnet. That reads like a wallet bug and is not one. `e2e-bridge.yml` runs this suite with
  // E2E_NETWORK=testnet; nothing else should.
  test.skip(
    (process.env.E2E_NETWORK ?? 'testnet') !== 'testnet',
    'needs public Miden testnet: the AggLayer bridge account is loaded as a foreign account and does not exist on a local chain'
  );

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
    await expectRegistryApproves(walletA.page, MIDEN_AGGLAYER_FAUCET_ID);
    const { faucetHex } = await fundBridgeToken(midenCli, walletA, { symbol: TOKEN_SYMBOL, decimals: 6 }, timeline);

    const destination = newEvmDestination();

    await openRouteStep(walletA, {
      destAddress: destination,
      tokenSymbol: TOKEN_SYMBOL,
      amount: BRIDGE_AMOUNT
    });
    await expectSlowRouteUnsupported(walletA);
    await backToAmountStep(walletA);
    await allowAgglayerFaucetForE2E(walletA.page, faucetHex);
    await confirmAmountStep(walletA);
    await selectSlowAndSubmit(walletA);

    // The Miden-side bridge-send is the wallet's real work: create + prove +
    // submit the B2AGG note. Poll the agglayer `bridged-send` row to Completed(2).
    await expect
      .poll(
        async () => {
          const row = (await readBridgedSendRows(walletA.page)).find(r => r.extraInputs?.provider === 'agglayer');
          // Carry the REASON in the polled value. `.poll().toBe(2)` can only report the value it
          // saw, so a Failed row otherwise surfaces as a bare `Received: 3` -- a status code with
          // no cause, which is exactly what made the last bridge failure need a code read to
          // diagnose. Returning the error here puts it straight in the assertion message.
          if (row?.status === 3) {
            return `Failed(3): ${row.rawError ?? row.error ?? 'no error recorded on the row'}`;
          }
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
    // The exit hash the row looks its own deposit up by, stored when the note was built (#1325).
    expect(row!.extraInputs?.agglayerExitTxHash, 'the exit hash binding the row to its deposit').toMatch(
      /^0x[0-9a-f]{64}$/
    );
    // The browser binding computed that hash. The vectors pin the formula on the napi addon only, so a browser-side
    // divergence (FeltArray handling, felt order) would store a well-formed hash no deposit ever matches.
    expect(row!.requestBytes, 'the request bytes the row was queued with').toBeDefined();
    expect(row!.extraInputs?.agglayerExitTxHash, 'the browser exit hash equals the napi SDK one').toBe(
      napiExitTxHashFromRequestBytes(Uint8Array.from(row!.requestBytes ?? []))
    );

    // Negative guards against green-on-nothing:
    //  - the Slow route was actually taken (not the silent agglayer->epoch fallback);
    expect(row!.extraInputs?.provider, 'route = agglayer, not the epoch fallback').toBe('agglayer');
    //  - only the Miden leg is asserted; the EVM claim has not (and cannot here) happened.
    expect(row!.extraInputs?.claimStatus ?? 'pending', 'EVM L1 claim still pending').toBe('pending');
  });
});
