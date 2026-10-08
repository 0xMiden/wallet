import { createPublicClient, decodeFunctionData, http, isHash } from 'viem';
import { sepolia } from 'viem/chains';

import {
  ERC20_APPROVE_ABI,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { expect, test } from '../fixtures/two-simulators';
import { AnvilInstance } from '../helpers/anvil';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';
import {
  FORK_USDC_ADDRESS,
  FORK_XRESERVE_ADDRESS,
  fundForkUsdc,
  readForkUsdcBalance,
  registerMidenDomainOnFork
} from '../helpers/xreserve-fork';

/**
 * Bridge-IN deposit e2e — FULL real UI (EVM → Miden, Circle xReserve/USDC route),
 * against Circle's REAL xReserve contract on a local Anvil FORK of Sepolia.
 *
 * No contract on the path is a double. The fork carries Sepolia's xReserve, its
 * Gateway wallet and Sepolia's USDC as they are deployed:
 *   1. Real WalletConnect pairing (app native Reown ↔ headless counterparty).
 *   2. Real UI: Receive → Cross Chain → USDC → amount → route (Circle xReserve) →
 *      review → Confirm Deposit.
 *   3. Real deposit: the wallet reads `isRemoteDomainRegistered` from xReserve,
 *      then builds a REAL `approve` and a REAL `depositToRemote`. The counterparty
 *      signs and broadcasts both to the fork, where xReserve pulls the USDC and
 *      passes it to the Gateway wallet, and the wallet waits for each receipt.
 *   4. The tracking row moves `submitting` → `delivering`.
 *
 * Two things differ from a deposit on the live chain; helpers/xreserve-fork.ts
 * gives the reasons:
 *   - The chain is Sepolia, not Arc Testnet: an Arc fork cannot move Arc's USDC.
 *   - The fork registers the Miden domain on xReserve through impersonated admin
 *     accounts, because Circle registered it on Arc only.
 *
 * The test stops at `delivering`. Circle's attestation service does not see a
 * fork, so nothing signs the deposit and no mint follows.
 *
 * Build requires `E2E_EVM_RPC_URL=http://127.0.0.1:8545` (Sepolia reads → the
 * fork) and `MIDEN_E2E_USDCX_CHAIN=sepolia` (the wallet's USDCx route uses
 * Sepolia's xReserve and USDC). The run reads the fork state from
 * `E2E_SEPOLIA_FORK_URL`, or a public Sepolia RPC when that is unset.
 */
test.describe('Bridge-IN deposit (Circle xReserve/USDC on a Sepolia fork, full real UI)', () => {
  test.describe.configure({ mode: 'serial' });
  // The wallet deposits on the chain its build names. Without the flag it would send
  // Arc's token address to Sepolia's xReserve, which reverts.
  test.skip(
    (process.env.MIDEN_E2E_USDCX_CHAIN ?? '').trim() !== 'sepolia',
    'requires an app built with MIDEN_E2E_USDCX_CHAIN=sepolia (set it for the build and the run)'
  );

  const ANVIL_PORT = 8545;
  const FORK_URL = (process.env.E2E_SEPOLIA_FORK_URL ?? '').trim() || 'https://ethereum-sepolia-rpc.publicnode.com';
  const DEPOSIT_USDC = '2';
  // USDC has 6 decimals.
  const DEPOSIT_UNITS = 2_000_000n;
  const FUNDED_UNITS = 100_000_000n;

  let anvil: AnvilInstance;

  test.beforeAll(async () => {
    // --block-time 1 keeps blocks advancing so both receipt waits can confirm.
    anvil = await AnvilInstance.start({
      port: ANVIL_PORT,
      chainId: sepolia.id,
      forkUrl: FORK_URL,
      args: ['--block-time', '1']
    });
    await registerMidenDomainOnFork(anvil.rpcUrl);
  });

  test.afterAll(async () => {
    anvil?.stop();
  });

  test('deposit USDC via the real UI (Circle xReserve) reaches delivering', async ({ walletA, walletB, steps }) => {
    const cp = new WcCounterparty();
    const evm = createPublicClient({ chain: sepolia, transport: http(anvil.rpcUrl) });
    let bridgeTxId: string;

    const sentTo = (address: string) => (r: WcRequestLog) =>
      r.method === 'eth_sendTransaction' &&
      (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === address.toLowerCase();
    const calldataOf = (r: WcRequestLog): `0x${string}` => {
      const tx = (r.params as Array<Record<string, string>>)[0];
      if (!tx?.data) throw new Error('transaction request had no calldata');
      return tx.data as `0x${string}`;
    };

    await steps.step('fund_depositor', async () => {
      // An exact balance, so the deposit can be checked as an exact debit.
      await fundForkUsdc(anvil.rpcUrl, cp.address, FUNDED_UNITS);
    });

    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
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
        // Token defaults to USDC, and USDC has one route: Circle xReserve.
        await walletA.openBridgeDeposit();
        await walletA.enterBridgeAmount(DEPOSIT_USDC);
        await walletA.confirmBridgeRouteUsdcx();
        await walletA.confirmBridgeDeposit();
      });

      await steps.step('assert_real_approve_broadcast', async () => {
        const isApprove = sentTo(FORK_USDC_ADDRESS);
        await expect
          .poll(() => cp.requests.find(isApprove) ?? null, { timeout: 90_000, intervals: [1500] })
          .not.toBeNull();
        const req = cp.requests.find(isApprove)!;
        expect(req.error, 'approve was broadcast without an error').toBeUndefined();

        const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: calldataOf(req) });
        expect(decoded.functionName).toBe('approve');
        const [spender, value] = decoded.args;
        expect(spender.toLowerCase(), 'spender = xReserve').toBe(FORK_XRESERVE_ADDRESS.toLowerCase());
        expect(value, 'approved amount = deposit amount').toBe(DEPOSIT_UNITS);
      });

      await steps.step('assert_real_deposit_executed', async () => {
        // The deposit follows the approval's receipt, so it lands a few blocks later.
        const isDeposit = sentTo(FORK_XRESERVE_ADDRESS);
        await expect
          .poll(() => cp.requests.find(isDeposit) ?? null, { timeout: 90_000, intervals: [1500] })
          .not.toBeNull();
        const req = cp.requests.find(isDeposit)!;
        expect(req.error, 'deposit was broadcast without an error').toBeUndefined();

        const decoded = decodeFunctionData({ abi: XRESERVE_ABI, data: calldataOf(req) });
        if (decoded.functionName !== 'depositToRemote') {
          throw new Error(`expected depositToRemote, got ${decoded.functionName}`);
        }
        const [value, remoteDomain, remoteRecipient, localToken, maxFee, hookData] = decoded.args;
        expect(value, 'deposit amount').toBe(DEPOSIT_UNITS);
        expect(remoteDomain, 'remote domain = Miden').toBe(USDCX_REMOTE_DOMAIN);
        expect(localToken.toLowerCase(), 'deposited token = Sepolia USDC').toBe(FORK_USDC_ADDRESS.toLowerCase());
        expect(maxFee, 'max fee').toBe(USDCX_DEPOSIT_MAX_FEE);
        expect(hookData, 'hook data').toBe(USDCX_DEPOSIT_HOOK_DATA);
        // The recipient is the 15-byte Miden account id plus one zero byte, left-padded
        // to 32 bytes: 16 zero bytes, then the id, then `00`.
        expect(remoteRecipient, 'recipient layout').toMatch(/^0x0{32}[0-9a-f]{30}00$/);
        expect(remoteRecipient, 'recipient is not empty').not.toMatch(/^0x0{64}$/);

        // The real xReserve accepted the deposit: the transaction succeeded, xReserve
        // logged it, and the depositor's USDC fell by exactly the deposit.
        if (typeof req.result !== 'string' || !isHash(req.result)) {
          throw new Error(`the deposit returned no transaction hash: ${String(req.result)}`);
        }
        const receipt = await evm.waitForTransactionReceipt({ hash: req.result, timeout: 60_000 });
        expect(receipt.status, 'deposit transaction status').toBe('success');
        expect(
          receipt.logs.some(log => log.address.toLowerCase() === FORK_XRESERVE_ADDRESS.toLowerCase()),
          'xReserve emitted a deposit event'
        ).toBe(true);
        expect(await readForkUsdcBalance(anvil.rpcUrl, cp.address), 'depositor USDC after the deposit').toBe(
          FUNDED_UNITS - DEPOSIT_UNITS
        );
      });

      await steps.step('row_reaches_delivering', async () => {
        const row = await walletA.latestBridgeReceive('usdcx');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        // The row carries the USDCx faucet id, which is the chain's native asset id.
        expect(row!.faucetId, 'row names the USDCx faucet').not.toBe('');
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 60_000,
            intervals: [2000]
          })
          .toBe('delivering');
      });

      await steps.step('assert_single_deposit', async () => {
        // One approval and one deposit: the wallet did not prompt twice.
        expect(cp.requests.filter(sentTo(FORK_USDC_ADDRESS))).toHaveLength(1);
        expect(cp.requests.filter(sentTo(FORK_XRESERVE_ADDRESS))).toHaveLength(1);
      });
    } finally {
      await cp.stop();
    }
  });
});
