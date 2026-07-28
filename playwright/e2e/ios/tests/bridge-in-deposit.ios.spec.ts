import { decodeFunctionData, parseUnits, zeroAddress } from 'viem';

import { expect, test } from '../fixtures/two-simulators';
import { AnvilInstance } from '../helpers/anvil';
import {
  AGGLAYER_BRIDGE_ADDRESS,
  installAggLayerBridge,
  installMockUsdc,
  readBridgeDepositCount
} from '../helpers/evm-doubles';
import { WcCounterparty } from '../helpers/wc-counterparty';

/**
 * Bridge-IN deposit e2e — FULL real UI (EVM → Miden, AggLayer "Slow"/ETH route).
 *
 * End-to-end, with only the chain (Anvil) and the AggLayer bridge contract
 * (a minimal-real stub enforcing `msg.value == amount`) standing in for public
 * Sepolia — every other leg is real:
 *   1. Real WalletConnect pairing (app native Reown ↔ headless counterparty over
 *      the public relay).
 *   2. Real UI: Receive → Cross Chain → token drawer (ETH) → amount → route
 *      (Slow/AggLayer) → review → Confirm Deposit.
 *   3. Real deposit: the app builds `bridgeAsset` calldata and asks the connected
 *      wallet to sign; the counterparty signs + broadcasts to Anvil; the app
 *      waits for the (real) receipt → phase `delivering`.
 *   4. Real Miden receipt: the miden-client CLI (AggLayer "solver") delivers a
 *      matching-amount note; the wallet's real sync + Claim-All consumes it and
 *      the real reconciler tags it "Bridged from EVM" → phase `received`.
 *
 * Requires the app to be built with `E2E_EVM_RPC_URL=http://127.0.0.1:8545` so
 * its EVM reads (balance, receipt) hit this Anvil (see config.ts override).
 */
test.describe('Bridge-IN deposit (AggLayer/ETH, full real UI)', () => {
  test.describe.configure({ mode: 'serial' });

  const ANVIL_PORT = 8545;
  const CHAIN_ID = 11155111;
  // The amount input caps at 6 decimals (CurrencyInput decimalsLimit=6), so the
  // smallest ETH deposit is 0.000001 → parseUnits(.,18) = 1e12 base units. The
  // matching Miden note must be minted for exactly that, so the solver faucet
  // needs max_supply > 1e12 (see FAUCET_MAX_SUPPLY below).
  const DEPOSIT_ETH = '0.000001';
  const FAUCET_MAX_SUPPLY = 1_000_000_000_000_000n; // 1e15, ample headroom over the 1e12 note

  const BRIDGE_ASSET_ABI = [
    {
      type: 'function',
      name: 'bridgeAsset',
      stateMutability: 'payable',
      inputs: [
        { name: 'destinationNetwork', type: 'uint32' },
        { name: 'destinationAddress', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'forceUpdateGlobalExitRoot', type: 'bool' },
        { name: 'permitData', type: 'bytes' }
      ],
      outputs: []
    }
  ] as const;

  let anvil: AnvilInstance;

  test.beforeAll(async () => {
    anvil = await AnvilInstance.start({ port: ANVIL_PORT, chainId: CHAIN_ID });
    await installAggLayerBridge(anvil.rpcUrl);
    // The deposit screen defaults to USDC and reads its balance on mount; without
    // a contract at the USDC address the eth_call returns "0x" and viem throws,
    // breaking the amount screen before we can switch to ETH.
    await installMockUsdc(anvil.rpcUrl);
  });

  test.afterAll(() => {
    anvil?.stop();
  });

  test('deposit ETH via the real UI reconciles to received', async ({ walletA, walletB, midenCli, steps }) => {
    const cp = new WcCounterparty();
    let addressA: string;
    let faucetHex: string;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
      addressA = a.address;
    });

    await steps.step('deploy_solver_faucet_and_point_matcher', async () => {
      await midenCli.init();
      faucetHex = await midenCli.createFaucet('TST', 8, FAUCET_MAX_SUPPLY);
      const faucetBech32 = await walletA.hexToBech32Faucet(faucetHex);
      await walletA.setAgglayerSender(faucetBech32);
    });

    try {
      await steps.step('connect_evm', async () => {
        // The public relay rate-limits connection bursts on the shared free-tier
        // projectId and its subscribe can time out mid-handshake, so retry the
        // WHOLE handshake (URI fetch + pair + approve) with backoff — the
        // CI-reliability guard for the relay dependency.
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      await steps.step('deposit_via_ui', async () => {
        await walletA.openBridgeDeposit();
        await walletA.selectBridgeToken('ETH');
        await walletA.enterBridgeAmount(DEPOSIT_ETH);
        await walletA.selectBridgeRouteSlow();
        await walletA.confirmBridgeDeposit();
      });

      await steps.step('assert_real_bridgeAsset_broadcast', async () => {
        // The app signed a real bridgeAsset via the counterparty, which broadcast
        // it to Anvil. Assert the calldata is a correct native-ETH deposit — not
        // "green on any calldata".
        await expect
          .poll(() => cp.requests.find(r => r.method === 'eth_sendTransaction') ?? null, {
            timeout: 60_000,
            intervals: [1000]
          })
          .not.toBeNull();
        const req = cp.requests.find(r => r.method === 'eth_sendTransaction')!;
        const tx = (req.params as Array<Record<string, string>>)[0];
        if (!tx) throw new Error('eth_sendTransaction had no tx params');
        expect(tx.to?.toLowerCase(), 'deposit target = AggLayer bridge').toBe(AGGLAYER_BRIDGE_ADDRESS.toLowerCase());

        const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: tx.data as `0x${string}` });
        expect(decoded.functionName).toBe('bridgeAsset');
        const [destNetwork, destAddress, amount, tokenArg] = decoded.args;
        const expectedAmount = parseUnits(DEPOSIT_ETH, 18);
        expect(destNetwork, 'destinationNetwork = MIDEN_CHAIN_ID').toBe(78);
        expect(tokenArg, 'token = native ETH').toBe(zeroAddress);
        expect(amount, 'bridged amount').toBe(expectedAmount);
        expect(destAddress, 'recipient is a real 20-byte address').toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(BigInt(tx.value ?? '0'), 'msg.value == amount').toBe(expectedAmount);

        // The stub actually executed the deposit (its counter advanced).
        expect(await readBridgeDepositCount(anvil.rpcUrl)).toBe(1);
      });

      let bridgeTxId: string;
      let rowAmount: string;
      await steps.step('row_reaches_delivering', async () => {
        const row = await walletA.latestBridgeReceive('agglayer');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        rowAmount = row!.amount!;
        expect(rowAmount, 'row amount = parseUnits(deposit,18)').toBe(parseUnits(DEPOSIT_ETH, 18).toString());
        // After the real Anvil receipt, handleSlowBridge advances to `delivering`.
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 60_000,
            intervals: [2000]
          })
          .toBe('delivering');
      });

      await steps.step('solver_delivers_note', async () => {
        await midenCli.mint(faucetHex, addressA, BigInt(rowAmount), 'public');
        await midenCli.sync();
      });

      await steps.step('wallet_consumes_note', async () => {
        await walletA.claimAllNotes(420_000, [faucetHex]);
      });

      await steps.step('assert_received', async () => {
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 120_000,
            intervals: [3000]
          })
          .toBe('received');
        const state = await walletA.getBridgeReceiveState(bridgeTxId);
        expect(state.displayMessage, 'tagged as bridge-in').toBe('Bridged from EVM');
      });
    } finally {
      await cp.stop();
    }
  });
});
