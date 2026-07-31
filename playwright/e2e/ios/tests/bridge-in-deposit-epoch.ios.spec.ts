import { decodeFunctionData } from 'viem';

import { expect, test } from '../fixtures/two-simulators';
import { AnvilInstance } from '../helpers/anvil';
import {
  MOCK_COMPACT_ADDRESS,
  MOCK_USDC_ADDRESS,
  installMockCompact,
  installMockUsdc,
  readCompactDepositCount
} from '../helpers/evm-doubles';
import { FakeEpochAllocator } from '../helpers/fake-epoch-allocator';
import { WcCounterparty } from '../helpers/wc-counterparty';

/**
 * Bridge-IN deposit e2e — FULL real UI (EVM → Miden, Epoch "Fast"/USDC route).
 *
 * The Epoch solver is hosted-only and watches REAL Sepolia, so it can't settle a
 * local Anvil deposit — this harness stubs the allocator + solver but keeps every
 * wallet-facing leg real:
 *   1. Real WalletConnect pairing (app native Reown ↔ headless counterparty).
 *   2. Real UI: Receive → Cross Chain → USDC → amount → route (Fast/Epoch) →
 *      review → Confirm Deposit.
 *   3. Real deposit: the Epoch SDK reads the (stubbed) Compact + USDC on Anvil,
 *      builds a REAL `depositERC20AndRegister`, the counterparty signs+broadcasts
 *      it to Anvil, and the SDK waits for the real receipt (confirmations:3).
 *   4. The wallet registers the intent and polls the fake allocator; the CLI
 *      "solver" delivers a Miden note whose id is programmed into the allocator,
 *      and the wallet's real Claim-All + note-id reconcile tags it "Bridged from
 *      EVM" → phase `received`.
 *
 * Build requires `E2E_EVM_RPC_URL=http://127.0.0.1:8545` (EVM reads → Anvil) and
 * `EPOCH_ALLOCATOR_URL=http://127.0.0.1:8548` (SDK allocator calls → the fake).
 */
test.describe('Bridge-IN deposit (Epoch/USDC, full real UI)', () => {
  test.describe.configure({ mode: 'serial' });

  const ANVIL_PORT = 8545;
  const ALLOCATOR_PORT = 8548;
  const CHAIN_ID = 11155111;
  const DEPOSIT_USDC = '1'; // any amount — the Epoch reconcile is note-id-only
  const FAUCET_MAX_SUPPLY = 1_000_000_000_000_000n;
  const NOTE_AMOUNT = 500_000_000n; // arbitrary; not part of the reconcile match

  const DEPOSIT_ABI = [
    {
      type: 'function',
      name: 'depositERC20AndRegister',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'lockTag', type: 'bytes12' },
        { name: 'amount', type: 'uint256' },
        { name: 'claimHash', type: 'bytes32' },
        { name: 'typehash', type: 'bytes32' }
      ],
      outputs: [{ name: '', type: 'uint256' }]
    }
  ] as const;

  let anvil: AnvilInstance;
  const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);

  test.beforeAll(async () => {
    // --block-time 1 keeps blocks advancing so the SDK's deposit receipt-wait
    // (waitForTransactionReceipt confirmations:3) can reach 3 confirmations.
    anvil = await AnvilInstance.start({ port: ANVIL_PORT, chainId: CHAIN_ID, args: ['--block-time', '1'] });
    await installMockUsdc(anvil.rpcUrl);
    await installMockCompact(anvil.rpcUrl);
    await allocator.start();
  });

  test.afterAll(async () => {
    anvil?.stop();
    await allocator.stop();
  });

  test('deposit USDC via the real UI (Fast/Epoch) reconciles to received', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    const cp = new WcCounterparty();
    let addressA: string;
    let faucetHex: string;
    let bridgeTxId: string;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
      addressA = a.address;
    });

    await steps.step('deploy_solver_faucet', async () => {
      await midenCli.init();
      faucetHex = await midenCli.createFaucet('TST', 8, FAUCET_MAX_SUPPLY);
    });

    try {
      await steps.step('connect_evm', async () => {
        // Retries the whole WC handshake (URI fetch + pair + approve) with backoff
        // — the public relay's subscribe intermittently times out mid-handshake.
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      await steps.step('deposit_via_ui', async () => {
        // Token defaults to USDC + route defaults to Epoch/Fast; entering the
        // amount triggers the (fake) allocator quote that gates the route.
        await walletA.openBridgeDeposit();
        await walletA.enterBridgeAmount(DEPOSIT_USDC);
        await walletA.selectBridgeRouteFast();
        await walletA.confirmBridgeDeposit();
      });

      await steps.step('assert_real_deposit_broadcast', async () => {
        // The Epoch SDK built a real depositERC20AndRegister and the counterparty
        // broadcast it to Anvil (single tx — MockUsdc's max allowance skips approve).
        const isDeposit = (r: { method: string; params: unknown }) =>
          r.method === 'eth_sendTransaction' &&
          (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === MOCK_COMPACT_ADDRESS.toLowerCase();
        await expect
          .poll(() => cp.requests.find(isDeposit) ?? null, { timeout: 90_000, intervals: [1500] })
          .not.toBeNull();
        const req = cp.requests.find(isDeposit)!;
        const tx = (req.params as Array<Record<string, string>>)[0];
        if (!tx) throw new Error('deposit tx had no params');

        const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data: tx.data as `0x${string}` });
        expect(decoded.functionName).toBe('depositERC20AndRegister');
        const [token, , amount] = decoded.args;
        expect(token.toLowerCase(), 'deposited token = USDC').toBe(MOCK_USDC_ADDRESS.toLowerCase());
        expect(amount, 'deposit amount > 0').toBeGreaterThan(0n);

        // The Compact stub actually executed the deposit — not green against dead
        // code. The allocation is registered (/compact) only AFTER the SDK's
        // post-deposit receipt wait (confirmations:3), so poll rather than assert
        // immediately (the deposit broadcast lands well before createAllocation).
        expect(await readCompactDepositCount(anvil.rpcUrl)).toBe(1);
        await expect
          .poll(() => allocator.requests.some(r => r.path === '/compact'), { timeout: 60_000, intervals: [1000] })
          .toBe(true);
      });

      await steps.step('row_reaches_delivering', async () => {
        const row = await walletA.latestBridgeReceive('epoch');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 60_000,
            intervals: [2000]
          })
          .toBe('delivering');
      });

      await steps.step('solver_delivers_note', async () => {
        const { noteId } = await midenCli.mint(faucetHex, addressA, NOTE_AMOUNT, 'public');
        // Program the fake allocator so its intentStatus poll reports this exact
        // note id — the wallet's note-id reconcile matches on it.
        allocator.setMidenNoteId(noteId);
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
