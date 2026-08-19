import { expect, test } from '../../fixtures/two-wallets';
import { bridgeOutFast, fundBridgeToken, readBridgedSendRows } from '../../helpers/bridge';
import { newEvmDestination, sepoliaPublicClient, usdcBalanceOf, waitForUsdcAbove } from '../../helpers/sepolia';

/**
 * Bridge-OUT, Fast (Epoch) — real Miden testnet -> Sepolia bridging, UI only.
 *
 * A funded Miden wallet bridges a self-minted token to a fresh 0x address via the
 * Fast route. There is NO connected EVM wallet: the wallet mints a Miden P2IDE
 * note to the Epoch allocator and the hosted solver settles the EVM leg. Asserts
 * both legs:
 *   1. Miden side  — the `bridged-send` activity row reaches Completed ("Bridged to EVM").
 *   2. EVM side    — real USDC lands at the destination on Sepolia (read via viem).
 *
 * The whole path is driven through the real Send UI. Requires public testnet
 * reachability (Miden testnet + the hosted Epoch allocator/solver + a Sepolia
 * RPC), so this suite is testnet/nightly, not a per-PR gate.
 */
// BLOCKED on an external dependency — re-enable when it is resolved (#627).
//
// The Epoch solver stopped quoting this pair on 2026-08-12. It answers 200 OK and
// DECLINES: `{"success":false,"error":"A quote isn't available for this intent",
// "code":"NO_QUOTE_AVAILABLE"}` from POST /checkIfDepositNeeded.
//
// This is NOT a wallet regression, and that was established rather than assumed:
// re-running the last green commit (8d82252d, passed 2026-08-12 10:20) against
// today's environment reproduces the identical failure, so the same bytes pass
// then and fail now.
//
// Why: this spec mints a THROWAWAY faucet (`BRDG`) per run, and Epoch's shipped
// token registry (`testnetGraph` in @epoch-protocol/epoch-commons-sdk, and their
// "Supported Chains & Tokens" docs) lists only USDC/DAI/USDT/WETH/WBTC/MIDEN on
// Miden. `BRDG` was never in it. The most consistent reading is that quoting used
// to accept arbitrary Miden faucets and is now restricted to that set.
//
// Un-skipping needs a token the solver actually prices — i.e. a Miden testnet
// balance of a registry token (e.g. USDC faucet 0xfc90f0f4da30e51168453b60eafed7),
// sourced from `testnetGraph` rather than hardcoded. Neither Epoch's SDK, their
// API (/faucet, /mint, /tokens all 404), nor our own faucet-api (single fixed
// token, no faucet-id parameter) can mint it, so it needs Epoch to fund or drip.
//
// Coverage is NOT lost meanwhile: the same bridge-OUT flow runs on every PR
// against the hermetic FakeEpochAllocator (`pr-e2e-bridge-guardian.yml`,
// EPOCH_ALLOCATOR_URL=127.0.0.1:8548 → bridge-out-epoch-guardian.spec.ts). What
// is paused is only the LIVE-solver assertion. `bridge-out-agglayer.spec.ts` is
// unaffected and still guards the other route on main.
test.describe.skip('bridge-out Miden to Sepolia (Fast Epoch)', () => {
  test.describe.configure({ mode: 'serial' });

  const TOKEN_SYMBOL = 'BRDG';
  const BRIDGE_AMOUNT = '1'; // ~1 USDC out — a small, liquidity-friendly solver fill

  // Funding (~150s) + Miden send/prove/complete (~2m) + solver settlement (~3m).
  test.setTimeout(900_000);

  test('bridges a token to a 0x address; the row completes and real USDC arrives on Sepolia', async ({
    walletA,
    midenCli,
    timeline
  }) => {
    await walletA.createNewWallet();
    await fundBridgeToken(midenCli, walletA, { symbol: TOKEN_SYMBOL, decimals: 6 }, timeline);

    // A fresh destination starts with zero USDC — so any credit is unambiguously
    // this bridge's settlement.
    const evm = sepoliaPublicClient();
    const destination = newEvmDestination();
    const before = await usdcBalanceOf(evm, destination);
    expect(before, 'fresh destination should start with 0 USDC').toBe(0n);

    await bridgeOutFast(walletA, { destAddress: destination, tokenSymbol: TOKEN_SYMBOL, amount: BRIDGE_AMOUNT });

    // Leg 1 (Miden): the bridged-send row completes and is labelled "Bridged to EVM".
    await expect
      .poll(async () => (await readBridgedSendRows(walletA.page)).find(r => r.status === 2)?.status ?? null, {
        timeout: 240_000,
        intervals: [3000]
      })
      .toBe(2);
    const [row] = await readBridgedSendRows(walletA.page);
    expect(row?.displayMessage, 'bridged-send display label').toBe('Bridged to EVM');

    // Leg 2 (EVM): the hosted solver delivered real USDC to the destination.
    const after = await waitForUsdcAbove(evm, destination, before, 300_000);
    expect(after, 'destination Sepolia USDC after bridge').toBeGreaterThan(before);
  });
});
