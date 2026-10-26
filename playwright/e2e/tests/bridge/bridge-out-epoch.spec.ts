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
// Opt-in, because it spends a real solver fill and cannot be made hermetic:
// `yarn e2e:real --suite bridge-out-epoch`, which preflights the solver and sets
// E2E_REAL_EPOCH. Deliberately out of the unattended main run - a third party
// declining to quote should not red `main`.
//
// The history explains the gate rather than the skip. This was `describe.skip`
// from 2026-08-13 to 2026-09-18 (#627, #628): Epoch's solver had begun answering
// 200 OK with `{"success":false,"code":"NO_QUOTE_AVAILABLE"}` from POST
// /checkIfDepositNeeded for the throwaway `BRDG` faucet this spec mints, and the
// reading then was that quoting had been restricted to the tokens in Epoch's
// `testnetGraph` registry (USDC/DAI/USDT/WETH/WBTC/MIDEN on Miden).
//
// That no longer reproduces, and the registry reading looks wrong: the allocator
// prices an intent from its MANDATE, whose `tokenIn` is the zero address for a
// Miden-sourced leg, so the quote is driven by `tokenOut` and an arbitrary
// `midenFaucetId` prices identically to a registry one. Re-probed 2026-09-18
// against testnet-dev.epochprotocol.xyz: 1.0 in -> 0.9917 USDC out via
// FillerSwapAndBridge, for both the registry USDC faucet and a made-up id.
//
// A quote is not a fill, and the fill is what this spec exists to prove - so the
// runner re-probes the quote before every run, which is what tells a service
// decline apart from a wallet regression without burning the full 15 minutes.
test.describe('bridge-out Miden to Sepolia (Fast Epoch)', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(
    process.env.E2E_REAL_EPOCH !== 'true',
    'live-solver run: opt in with `yarn e2e:real --suite bridge-out-epoch` (spends a real Epoch fill)'
  );

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
