import { Address } from '@miden-sdk/miden-sdk';
import { expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { decodeFunctionData, parseUnits, zeroAddress } from 'viem';

import { midenAccountIdToEvmAddr } from '../../../../src/lib/agglayer/miden-account-address';
import { TEST_NATIVE_ETH_SCALE } from '../../../../src/lib/epoch/testing/bridge-config';
import { FEE_RESERVE_MULTIPLE } from '../../../../src/lib/miden/fees/constants';
import { getEnvironmentConfig } from '../../config/environments';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { discoverVerificationBaseFee } from '../../helpers/fee-faucet';
import { requiredFeeGrantCount } from '../../helpers/fee-grant-budget';
import { publicFaucetApiUrl, publicFaucetGrantAmount } from '../../helpers/public-faucet';
import { AnvilInstance } from '../../ios/helpers/anvil';
import {
  AGGLAYER_BRIDGE_ADDRESS,
  installAggLayerBridge,
  installMockUsdc,
  readBridgeDepositCount
} from '../../ios/helpers/evm-doubles';
import { WcCounterparty } from '../../ios/helpers/wc-counterparty';
import { test } from '../fixtures/one-emulator';

const MAX_BRIDGE_IN_LOOPS = 100;
const DEFAULT_BRIDGE_IN_LOOPS = 1;
const configuredLoopCount = process.env.BRIDGE_IN_LOOP_COUNT?.trim();
const BRIDGE_IN_LOOP_COUNT = configuredLoopCount ? Number(configuredLoopCount) : DEFAULT_BRIDGE_IN_LOOPS;

if (
  !Number.isSafeInteger(BRIDGE_IN_LOOP_COUNT) ||
  BRIDGE_IN_LOOP_COUNT < 1 ||
  BRIDGE_IN_LOOP_COUNT > MAX_BRIDGE_IN_LOOPS
) {
  throw new Error(`BRIDGE_IN_LOOP_COUNT must be an integer from 1 to ${MAX_BRIDGE_IN_LOOPS}`);
}

if (BRIDGE_IN_LOOP_COUNT > 1 && process.env.BRIDGE_IN_ROUTE && process.env.BRIDGE_IN_ROUTE !== 'agglayer') {
  throw new Error('BRIDGE_IN_LOOP_COUNT > 1 requires BRIDGE_IN_ROUTE=agglayer');
}
if (BRIDGE_IN_LOOP_COUNT > 1 && process.env.E2E_NETWORK !== 'testnet') {
  throw new Error('BRIDGE_IN_LOOP_COUNT > 1 requires E2E_NETWORK=testnet');
}

type LoopPhase = 'started' | 'deposit_submitted' | 'miden_note_committed' | 'received' | 'failed';

interface AggLayerLoopRecord {
  loop: number;
  status: LoopPhase;
  startedAt: string;
  completedAt?: string;
  evmTxHash?: string;
  bridgeRowId?: string;
  midenTxId?: string;
  midenAmount?: string;
  midenNoteId?: string;
  receivedPhase?: string;
  error?: { name: string; message: string };
}

interface AggLayerLoopManifest {
  version: 1;
  route: 'agglayer';
  requestedLoops: number;
  completedLoops: number;
  totalMidenAmount: string;
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { name: string; message: string };
  feeBudget?: {
    baseFee: string;
    maxFeePerTransaction: string;
    publicGrantAmount: string;
    solverGrantCount: number;
    recipientGrantCount: number;
    solverRequiredReserve: string;
    recipientRequiredReserve: string;
    solverStartingBalance: string;
    recipientBalanceAfterLoops: Array<{ loop: number; balance: string; required: string }>;
    solverBalanceAfterLoops: Array<{ loop: number; balance: string; required: string }>;
  };
  loops: AggLayerLoopRecord[];
}

function persistManifest(outputDir: string, manifest: AggLayerLoopManifest): void {
  manifest.updatedAt = new Date().toISOString();
  manifest.completedLoops = manifest.loops.filter(loop => loop.status === 'received').length;
  manifest.totalMidenAmount = manifest.loops
    .filter(loop => loop.midenAmount !== undefined)
    .reduce((total, loop) => total + BigInt(loop.midenAmount!), 0n)
    .toString();
  const target = path.join(outputDir, 'agglayer-loop-manifest.json');
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function appendLoopEvent(outputDir: string, event: Record<string, unknown>): void {
  fs.appendFileSync(path.join(outputDir, 'agglayer-loops.ndjson'), `${JSON.stringify(event)}\n`);
}

function errorRecord(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function normalizeNoteId(noteId: string): string {
  return noteId.trim().toLowerCase().replace(/^0x/, '');
}

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
 *      note of the scaled amount the bridge would (wei / 10^10); the wallet's real sync + Claim-All consumes it and
 *      the real reconciler tags it "Bridged from EVM" → phase `received`.
 *
 * The Android bridge-in setup uses adb reverse, so the app reaches host Anvil
 * and the config server through its loopback address. The headless WalletConnect
 * counterparty uses the same host loopback directly.
 */
test.describe('Bridge-IN deposit (AggLayer/ETH, full real UI)', () => {
  // Reserve 50 minutes for the Android fixture, fee-faucet setup, and
  // WalletConnect plus 2.3 minutes per loop.
  test.describe.configure({
    mode: 'serial',
    timeout: BRIDGE_IN_LOOP_COUNT === 1 ? 25 * 60_000 : (50 + 2.3 * BRIDGE_IN_LOOP_COUNT) * 60_000
  });

  const ANVIL_PORT = 8545;
  const CHAIN_ID = 11155111;
  // The amount input caps at 6 decimals (CurrencyInput decimalsLimit=6), so the
  // smallest ETH deposit is 0.000001 → parseUnits(.,18) = 1e12 wei, which the row
  // records. The bridge delivers it scaled by its ETH faucet's registry scale
  // (the testnet registry's, TEST_NATIVE_ETH_SCALE), so the solver
  // mints 1e12 / 1e10 = 100 units.
  const DEPOSIT_ETH = '0.000001';
  const FAUCET_MAX_SUPPLY = 1_000_000_000_000_000n; // 1e15, ample headroom over the 100-unit note

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

  test(`deposit ETH via the real UI reconciles to received (${BRIDGE_IN_LOOP_COUNT} loop${BRIDGE_IN_LOOP_COUNT === 1 ? '' : 's'})`, async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    const cp = new WcCounterparty();
    let addressA!: string;
    let faucetHex!: string;
    const manifest: AggLayerLoopManifest = {
      version: 1,
      route: 'agglayer',
      requestedLoops: BRIDGE_IN_LOOP_COUNT,
      completedLoops: 0,
      totalMidenAmount: '0',
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      loops: []
    };
    let maxFeePerTransaction = 0n;
    let solverFeeGrantCount = 1;
    let recipientFeeGrantCount = 1;
    let nativeFaucetBech32 = '';
    persistManifest(steps.outputDir, manifest);
    appendLoopEvent(steps.outputDir, {
      event: 'run_started',
      route: manifest.route,
      requestedLoops: manifest.requestedLoops,
      at: manifest.startedAt
    });

    try {
      await steps.step('preflight_fee_reserve', async () => {
        if (BRIDGE_IN_LOOP_COUNT === 1) return;
        const environment = getEnvironmentConfig();
        const faucetApi = publicFaucetApiUrl(environment.name);
        if (!faucetApi) throw new Error(`No public fee faucet is configured for ${environment.name}`);
        const [baseFee, grantAmount] = await Promise.all([
          discoverVerificationBaseFee(environment.rpcUrl),
          publicFaucetGrantAmount(faucetApi)
        ]);
        if (baseFee <= 0) throw new Error(`Testnet verification base fee must be positive; got ${baseFee}`);
        maxFeePerTransaction = BigInt(baseFee) * BigInt(FEE_RESERVE_MULTIPLE);
        solverFeeGrantCount = requiredFeeGrantCount(BRIDGE_IN_LOOP_COUNT + 1, maxFeePerTransaction, grantAmount);
        recipientFeeGrantCount = requiredFeeGrantCount(BRIDGE_IN_LOOP_COUNT, maxFeePerTransaction, grantAmount);
        manifest.feeBudget = {
          baseFee: String(baseFee),
          maxFeePerTransaction: maxFeePerTransaction.toString(),
          publicGrantAmount: grantAmount.toString(),
          solverGrantCount: solverFeeGrantCount,
          recipientGrantCount: recipientFeeGrantCount,
          solverRequiredReserve: (BigInt(BRIDGE_IN_LOOP_COUNT) * maxFeePerTransaction).toString(),
          recipientRequiredReserve: (BigInt(BRIDGE_IN_LOOP_COUNT) * maxFeePerTransaction).toString(),
          solverStartingBalance: '0',
          recipientBalanceAfterLoops: [],
          solverBalanceAfterLoops: []
        };
        persistManifest(steps.outputDir, manifest);
        appendLoopEvent(steps.outputDir, {
          event: 'fee_reserve_planned',
          baseFee: manifest.feeBudget.baseFee,
          maxFeePerTransaction: manifest.feeBudget.maxFeePerTransaction,
          publicGrantAmount: manifest.feeBudget.publicGrantAmount,
          solverGrantCount: solverFeeGrantCount,
          recipientGrantCount: recipientFeeGrantCount,
          solverRequiredReserve: manifest.feeBudget.solverRequiredReserve,
          recipientRequiredReserve: manifest.feeBudget.recipientRequiredReserve,
          at: new Date().toISOString()
        });
      });

      await steps.step('create_wallet', async () => {
        const a = await walletA.createNewWallet();
        await walletB.createNewWallet(); // fixture requires both sims up
        addressA = a.address;
      });

      await steps.step('deploy_solver_faucet_and_point_matcher', async () => {
        await midenCli.init();
        faucetHex = await midenCli.createFaucet('TST', 8, FAUCET_MAX_SUPPLY, solverFeeGrantCount);
        if (manifest.feeBudget) {
          const solverBalance = await midenCli.nativeFeeBalance(faucetHex);
          const solverReserve = BigInt(manifest.feeBudget.solverRequiredReserve);
          expect(solverBalance, 'solver holds the full 100-mint fee reserve after deployment').toBeGreaterThanOrEqual(
            solverReserve
          );
          manifest.feeBudget.solverStartingBalance = solverBalance.toString();
          const nativeFaucetHex = await midenCli.ensureNativeFaucetId();
          if (!nativeFaucetHex) throw new Error('Testnet native fee faucet ID was not discovered');
          nativeFaucetBech32 = await walletA.hexToBech32Faucet(nativeFaucetHex);
          await midenCli.fundAccountForFees(addressA, recipientFeeGrantCount);
          expect(
            BigInt(recipientFeeGrantCount) * BigInt(manifest.feeBudget.publicGrantAmount),
            'pending recipient grants cover all maximum-cost claims'
          ).toBeGreaterThanOrEqual(BigInt(manifest.feeBudget.recipientRequiredReserve));
          persistManifest(steps.outputDir, manifest);
          appendLoopEvent(steps.outputDir, {
            event: 'fee_reserve_prepared',
            baseFee: manifest.feeBudget.baseFee,
            maxFeePerTransaction: manifest.feeBudget.maxFeePerTransaction,
            publicGrantAmount: manifest.feeBudget.publicGrantAmount,
            solverGrantCount: solverFeeGrantCount,
            recipientGrantCount: recipientFeeGrantCount,
            solverStartingBalance: manifest.feeBudget.solverStartingBalance,
            at: new Date().toISOString()
          });
        }
        const faucetBech32 = await walletA.hexToBech32Faucet(faucetHex);
        await walletA.setAgglayerSender(faucetBech32);
      });

      await steps.step('connect_evm', async () => {
        // The public relay rate-limits connection bursts and its subscribe can
        // time out mid-handshake, so retry the WHOLE handshake (URI fetch +
        // pair + approve) with backoff - the CI-reliability guard for the
        // relay dependency.
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      const anvilRpcUrl = anvil.rpcUrl;
      const solverFaucetHex = faucetHex;
      const recipientAccountId = addressA;
      const evmTxHashes = new Set<string>();
      const bridgeRowIds = new Set<string>();
      const midenTxIds = new Set<string>();
      const midenNoteIds = new Set<string>();

      for (let loopNumber = 1; loopNumber <= BRIDGE_IN_LOOP_COUNT; loopNumber++) {
        const label = `loop_${String(loopNumber).padStart(3, '0')}`;
        const loopMaxFeePerTransaction = maxFeePerTransaction;
        const loopNativeFaucetBech32 = nativeFaucetBech32;
        const loop: AggLayerLoopRecord = {
          loop: loopNumber,
          status: 'started',
          startedAt: new Date().toISOString()
        };
        manifest.loops.push(loop);
        persistManifest(steps.outputDir, manifest);
        appendLoopEvent(steps.outputDir, { event: 'loop_started', loop: loopNumber, at: loop.startedAt });

        try {
          const requestStartIndex = cp.requests.length;
          await steps.step(`${label}_deposit_via_ui`, async () => {
            await walletA.openBridgeDeposit();
            await walletA.selectBridgeToken('ETH');
            await walletA.enterBridgeAmount(DEPOSIT_ETH);
            await walletA.selectBridgeRouteSlow();
            await walletA.confirmBridgeDeposit();
          });

          await steps.step(`${label}_assert_real_bridgeAsset_broadcast`, async () => {
            const requestsForLoop = () =>
              cp.requests.slice(requestStartIndex).filter(request => request.method === 'eth_sendTransaction');
            await expect.poll(() => requestsForLoop().length, { timeout: 60_000, intervals: [1000] }).toBe(1);
            const request = requestsForLoop()[0];
            if (!request) throw new Error('WalletConnect did not record this loop transaction');
            expect(request.error, 'WalletConnect transaction was accepted').toBeUndefined();
            const txHash = request.result;
            expect(txHash, 'broadcast returned an EVM transaction hash').toMatch(/^0x[0-9a-fA-F]{64}$/);
            loop.evmTxHash = txHash as string;
            expect(evmTxHashes.has(loop.evmTxHash), 'each loop has a unique EVM deposit').toBe(false);

            const tx = (request.params as Array<Record<string, string>>)[0];
            if (!tx) throw new Error('eth_sendTransaction had no tx params');
            expect(tx.to?.toLowerCase(), 'deposit target = AggLayer bridge').toBe(
              AGGLAYER_BRIDGE_ADDRESS.toLowerCase()
            );

            const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data: tx.data as `0x${string}` });
            expect(decoded.functionName).toBe('bridgeAsset');
            const [destNetwork, destAddress, amount, tokenArg] = decoded.args;
            const expectedAmount = parseUnits(DEPOSIT_ETH, 18);
            expect(destNetwork, 'destinationNetwork = the testnet rollup id').toBe(73);
            expect(tokenArg, 'token = native ETH').toBe(zeroAddress);
            expect(amount, 'bridged amount').toBe(expectedAmount);
            expect(destAddress, 'recipient is a real 20-byte address').toMatch(/^0x[0-9a-fA-F]{40}$/);
            expect(destAddress.toLowerCase(), 'EVM deposit is addressed to this Miden wallet').toBe(
              midenAccountIdToEvmAddr(Address.fromBech32(recipientAccountId).accountId().toString()).toLowerCase()
            );
            expect(BigInt(tx.value ?? '0'), 'msg.value == amount').toBe(expectedAmount);

            expect(await readBridgeDepositCount(anvilRpcUrl), 'Anvil executed this loop deposit').toBe(loopNumber);
            loop.status = 'deposit_submitted';
            evmTxHashes.add(loop.evmTxHash);
            persistManifest(steps.outputDir, manifest);
            appendLoopEvent(steps.outputDir, {
              event: 'deposit_submitted',
              loop: loopNumber,
              evmTxHash: loop.evmTxHash,
              anvilDepositCount: loopNumber,
              at: new Date().toISOString()
            });
          });

          let rowAmount = '';
          await steps.step(`${label}_row_reaches_delivering`, async () => {
            const row = await walletA.latestBridgeReceive('agglayer');
            expect(row, 'bridged-receive row created by this UI deposit').not.toBeNull();
            loop.bridgeRowId = row!.id;
            rowAmount = row!.amount ?? '';
            expect(row!.evmTxHash?.toLowerCase(), 'bridge row maps to this EVM deposit').toBe(
              loop.evmTxHash!.toLowerCase()
            );
            expect(bridgeRowIds.has(loop.bridgeRowId), 'each loop has a unique bridge row').toBe(false);
            expect(rowAmount, 'row amount = parseUnits(deposit,18)').toBe(parseUnits(DEPOSIT_ETH, 18).toString());
            await expect
              .poll(async () => (await walletA.getBridgeReceiveState(loop.bridgeRowId!)).phase, {
                timeout: 60_000,
                intervals: [2000]
              })
              .toBe('delivering');
            bridgeRowIds.add(loop.bridgeRowId);
          });

          await steps.step(`${label}_solver_delivers_note`, async () => {
            const deliveredAmount = BigInt(rowAmount) / 10n ** BigInt(TEST_NATIVE_ETH_SCALE);
            expect(deliveredAmount, 'scaled solver amount matches the bridge deposit').toBe(
              parseUnits(DEPOSIT_ETH, 18) / 10n ** BigInt(TEST_NATIVE_ETH_SCALE)
            );
            const result = await midenCli.mint(solverFaucetHex, recipientAccountId, deliveredAmount, 'public');
            loop.midenTxId = result.txId;
            loop.midenNoteId = result.noteId;
            loop.midenAmount = deliveredAmount.toString();
            expect(midenTxIds.has(result.txId), 'each loop has a unique committed Miden transaction').toBe(false);
            expect(midenNoteIds.has(result.noteId), 'each loop has a unique Miden note').toBe(false);
            midenTxIds.add(result.txId);
            midenNoteIds.add(result.noteId);
            await midenCli.sync();
            loop.status = 'miden_note_committed';
            persistManifest(steps.outputDir, manifest);
            appendLoopEvent(steps.outputDir, {
              event: 'miden_note_committed',
              loop: loopNumber,
              evmTxHash: loop.evmTxHash,
              bridgeRowId: loop.bridgeRowId,
              midenTxId: result.txId,
              midenNoteId: result.noteId,
              amount: deliveredAmount.toString(),
              at: new Date().toISOString()
            });
          });

          await steps.step(`${label}_wallet_consumes_note`, async () => {
            await walletA.claimAllNotes(420_000, [solverFaucetHex]);
          });

          if (manifest.feeBudget) {
            await steps.step(`${label}_assert_recipient_fee_reserve`, async () => {
              const remainingClaims = BRIDGE_IN_LOOP_COUNT - loopNumber;
              const balance = await vaultBalanceByFaucetId(walletA, loopNativeFaucetBech32);
              const required = BigInt(remainingClaims) * loopMaxFeePerTransaction;
              expect(
                balance,
                'recipient retains the maximum fee budget for every remaining claim'
              ).toBeGreaterThanOrEqual(required);
              manifest.feeBudget!.recipientBalanceAfterLoops.push({
                loop: loopNumber,
                balance: balance.toString(),
                required: required.toString()
              });
              persistManifest(steps.outputDir, manifest);
              appendLoopEvent(steps.outputDir, {
                event: 'recipient_fee_reserve_checked',
                loop: loopNumber,
                balance: balance.toString(),
                required: required.toString(),
                at: new Date().toISOString()
              });
            });
            await steps.step(`${label}_assert_solver_fee_reserve`, async () => {
              const remainingMints = BRIDGE_IN_LOOP_COUNT - loopNumber;
              const balance = await midenCli.nativeFeeBalance(solverFaucetHex);
              const required = BigInt(remainingMints) * loopMaxFeePerTransaction;
              expect(balance, 'solver retains the maximum fee budget for every remaining mint').toBeGreaterThanOrEqual(
                required
              );
              manifest.feeBudget!.solverBalanceAfterLoops.push({
                loop: loopNumber,
                balance: balance.toString(),
                required: required.toString()
              });
              persistManifest(steps.outputDir, manifest);
              appendLoopEvent(steps.outputDir, {
                event: 'solver_fee_reserve_checked',
                loop: loopNumber,
                balance: balance.toString(),
                required: required.toString(),
                at: new Date().toISOString()
              });
            });
          }

          await steps.step(`${label}_assert_received`, async () => {
            await expect
              .poll(async () => (await walletA.getBridgeReceiveState(loop.bridgeRowId!)).phase, {
                timeout: 120_000,
                intervals: [3000]
              })
              .toBe('received');
            const state = await walletA.getBridgeReceiveState(loop.bridgeRowId!);
            expect(state.displayMessage, 'tagged as bridge-in').toBe('Bridged from EVM');
            expect(
              normalizeNoteId(state.midenNoteId ?? ''),
              'bridge row reconciles the exact note minted for this loop'
            ).toBe(normalizeNoteId(loop.midenNoteId ?? ''));
            loop.status = 'received';
            loop.completedAt = new Date().toISOString();
            loop.receivedPhase = state.phase;
            persistManifest(steps.outputDir, manifest);
            appendLoopEvent(steps.outputDir, {
              event: 'loop_received',
              loop: loopNumber,
              evmTxHash: loop.evmTxHash,
              bridgeRowId: loop.bridgeRowId,
              midenTxId: loop.midenTxId,
              midenNoteId: loop.midenNoteId,
              phase: state.phase,
              displayMessage: state.displayMessage,
              at: loop.completedAt
            });
          });
        } catch (error) {
          loop.status = 'failed';
          loop.completedAt = new Date().toISOString();
          loop.error = errorRecord(error);
          persistManifest(steps.outputDir, manifest);
          appendLoopEvent(steps.outputDir, {
            event: 'loop_failed',
            loop: loopNumber,
            evmTxHash: loop.evmTxHash,
            bridgeRowId: loop.bridgeRowId,
            midenTxId: loop.midenTxId,
            midenNoteId: loop.midenNoteId,
            error: loop.error,
            at: loop.completedAt
          });
          throw error;
        }
      }

      expect(manifest.completedLoops, 'all requested bridge-in loops reconciled').toBe(BRIDGE_IN_LOOP_COUNT);
      expect(await readBridgeDepositCount(anvilRpcUrl), 'Anvil deposit count matches completed loops').toBe(
        BRIDGE_IN_LOOP_COUNT
      );
      expect(evmTxHashes.size, 'all EVM deposits are unique').toBe(BRIDGE_IN_LOOP_COUNT);
      expect(bridgeRowIds.size, 'all bridge rows are unique').toBe(BRIDGE_IN_LOOP_COUNT);
      expect(midenTxIds.size, 'all committed Miden transactions are unique').toBe(BRIDGE_IN_LOOP_COUNT);
      expect(midenNoteIds.size, 'all delivered Miden notes are unique').toBe(BRIDGE_IN_LOOP_COUNT);
      expect(BigInt(manifest.totalMidenAmount), 'total Miden amount matches all deposits').toBe(
        (parseUnits(DEPOSIT_ETH, 18) / 10n ** BigInt(TEST_NATIVE_ETH_SCALE)) * BigInt(BRIDGE_IN_LOOP_COUNT)
      );

      manifest.status = 'passed';
      manifest.completedAt = new Date().toISOString();
      persistManifest(steps.outputDir, manifest);
      appendLoopEvent(steps.outputDir, {
        event: 'run_passed',
        requestedLoops: manifest.requestedLoops,
        completedLoops: manifest.completedLoops,
        at: manifest.completedAt
      });
    } catch (error) {
      manifest.status = 'failed';
      manifest.completedAt = new Date().toISOString();
      manifest.error = errorRecord(error);
      persistManifest(steps.outputDir, manifest);
      appendLoopEvent(steps.outputDir, {
        event: 'run_failed',
        requestedLoops: manifest.requestedLoops,
        completedLoops: manifest.completedLoops,
        error: manifest.error,
        at: manifest.completedAt
      });
      throw error;
    } finally {
      await cp.stop();
    }
  });
});
