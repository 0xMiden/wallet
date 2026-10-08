import { decodeFunctionData, encodeFunctionData, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import {
  CIRCLE_USDC_DECIMALS,
  ERC20_BALANCE_OF_ABI,
  getUsdcxContracts,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import { expect, test } from '../fixtures/two-simulators';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';

/**
 * Bridge-IN deposit e2e against the LIVE networks (Arc Testnet → Miden testnet,
 * Circle xReserve/USDC route). Nothing on the path is a double:
 *   1. Real WalletConnect pairing (app native Reown ↔ headless counterparty).
 *   2. Real UI: Receive → Cross Chain → Circle USDC → amount → route → review → Confirm.
 *   3. Real deposit: the counterparty signs with a funded Arc Testnet key and
 *      broadcasts `approve` and `depositToRemote` to the real xReserve contract.
 *   4. Circle's attestation service signs the deposit.
 *   5. The deposit relayer reads the attestation and submits the mint note to the
 *      USDCx faucet. By default this is the deployed relayer. The faucet does not
 *      look at who sent a mint note, so the spec needs no relayer of its own.
 *   6. The faucet mints, and the wallet claims the note.
 *
 * The run spends real Arc Testnet USDC (the deposit and the gas).
 *
 * Environment:
 *   USDCX_LIVE_EVM_PRIVATE_KEY        required: funded Arc Testnet key (USDC is the gas token too)
 *   USDCX_LIVE_DEPOSIT_AMOUNT         optional, in USDC; default 1
 *   USDCX_FAUCET_ACCOUNT_ID           optional: the USDCx faucet, for the claim step
 *
 * To test a relayer build before it is deployed, set these too and the spec starts
 * that relayer as a local process (all are then required, with the faucet id):
 *   USDCX_RELAYER_ACCOUNT_ID          funded Miden account that creates the mint notes
 *   USDCX_RELAYER_DATA_DIR            holds `keystore/` with that account's key
 *   USDCX_CIRCLE_ATTESTER_PUBLIC_KEY  the key Circle signs deposit attestations with
 * The spec skips when a required variable is unset, and names it.
 *
 * Build the app WITHOUT `E2E_EVM_RPC_URL`, so its Arc reads go to the real RPC.
 */

// `DomainDepositsPaused(uint32)`: Circle paused deposits for a remote domain on xReserve.
const DOMAIN_DEPOSITS_PAUSED_SELECTOR = '0x14e2708f';
const ATTESTATION_TIMEOUT_MS = 20 * 60_000;
const MINT_AND_CLAIM_TIMEOUT_MS = 15 * 60_000;

const evmPrivateKey = (process.env.USDCX_LIVE_EVM_PRIVATE_KEY ?? '').trim();
const relayerEnv = readUsdcxRelayerEnv();
// The deployed relayer mints by default. The spec starts a local one only when the relayer
// account or its data directory is set; the full set of relayer variables is then required.
const wantsLocalRelayer =
  (process.env.USDCX_RELAYER_ACCOUNT_ID ?? '').trim() !== '' ||
  (process.env.USDCX_RELAYER_DATA_DIR ?? '').trim() !== '';
const missingEnv = [
  ...(evmPrivateKey ? [] : ['USDCX_LIVE_EVM_PRIVATE_KEY']),
  ...(wantsLocalRelayer ? relayerEnv.missing : [])
];
// Optional: lets the claim step show a faucet whose metadata the wallet has not read yet.
const faucetAccountId = (process.env.USDCX_FAUCET_ACCOUNT_ID ?? '').trim();
const depositAmount = (process.env.USDCX_LIVE_DEPOSIT_AMOUNT ?? '').trim() || '1';
const depositUnits = parseUnits(depositAmount, CIRCLE_USDC_DECIMALS);
const arcRpcUrl = ARC_TESTNET.rpcUrls.default.http[0];
const { usdc: arcUsdc, xReserve } = getUsdcxContracts(ARC_TESTNET.id);

interface EthCallResult {
  result?: string;
  error?: { message?: string; data?: string };
}

async function arcEthCall(call: { from?: string; to: string; data: string }): Promise<EthCallResult> {
  const response = await fetch(arcRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] })
  });
  return (await response.json()) as EthCallResult;
}

test.describe('Bridge-IN deposit (Circle xReserve/USDC, live testnets)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    missingEnv.length > 0 || (process.env.E2E_NETWORK ?? 'testnet') !== 'testnet',
    `requires E2E_NETWORK=testnet and: ${missingEnv.join(', ') || 'nothing more'}`
  );

  let relayer: UsdcxRelayer | undefined;

  test.beforeAll(async () => {
    if (!wantsLocalRelayer || !relayerEnv.config) return;
    relayer = new UsdcxRelayer(relayerEnv.config);
    await relayer.start();
  });

  test.afterAll(async () => {
    await relayer?.stop();
  });

  test('deposit USDC via the real UI, Circle attests, the relayer mints, the wallet claims', async ({
    walletA,
    walletB,
    steps
  }) => {
    // Undefined when the deployed relayer mints; the checks below then have nothing to watch.
    const localRelayer = relayer;
    const cp = new WcCounterparty({
      privateKey: evmPrivateKey as `0x${string}`,
      rpcUrl: arcRpcUrl,
      chainId: ARC_TESTNET.id
    });
    const evmAddress = privateKeyToAccount(evmPrivateKey as `0x${string}`).address;
    let depositHash: `0x${string}`;
    let bridgeTxId: string;

    const sentTo = (address: string) => (r: WcRequestLog) =>
      r.method === 'eth_sendTransaction' &&
      (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === address.toLowerCase();

    await steps.step('preflight_arc', async () => {
      // Fail here, with the cause, instead of after the wallet prompts for a deposit that cannot pass.
      const balance = await arcEthCall({
        to: arcUsdc,
        data: encodeFunctionData({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [evmAddress] })
      });
      expect(BigInt(balance.result ?? '0x0'), `Arc USDC balance of ${evmAddress}`).toBeGreaterThan(depositUnits);

      const registered = await arcEthCall({
        to: xReserve,
        data: encodeFunctionData({
          abi: XRESERVE_ABI,
          functionName: 'isRemoteDomainRegistered',
          args: [USDCX_REMOTE_DOMAIN]
        })
      });
      expect(BigInt(registered.result ?? '0x0'), 'the Miden domain is registered on xReserve').toBe(1n);

      // A simulated deposit. Without an allowance it can revert for that reason, which is
      // not a blocker; only the pause error is decisive here.
      const simulated = await arcEthCall({
        from: evmAddress,
        to: xReserve,
        data: encodeFunctionData({
          abi: XRESERVE_ABI,
          functionName: 'depositToRemote',
          args: [
            depositUnits,
            USDCX_REMOTE_DOMAIN,
            `0x${'00'.repeat(16)}${'11'.repeat(15)}00`,
            arcUsdc,
            USDCX_DEPOSIT_MAX_FEE,
            USDCX_DEPOSIT_HOOK_DATA
          ]
        })
      });
      expect(
        simulated.error?.data?.startsWith(DOMAIN_DEPOSITS_PAUSED_SELECTOR) ?? false,
        `Circle has paused xReserve deposits for domain ${USDCX_REMOTE_DOMAIN}`
      ).toBe(false);
    });

    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
    });

    try {
      await steps.step('connect_evm', async () => {
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      await steps.step('deposit_via_ui', async () => {
        // The screen opens on the bridge's own USDC. Circle's USDC is the token xReserve
        // takes, and it has one route.
        await walletA.openBridgeDeposit();
        await walletA.selectBridgeToken('CIRCLE_USDC');
        await walletA.enterBridgeAmount(depositAmount);
        await walletA.confirmBridgeRouteUsdcx();
        await walletA.confirmBridgeDeposit();
      });

      await steps.step('assert_deposit_broadcast', async () => {
        // The deposit follows the approval's receipt on Arc.
        const isDeposit = sentTo(xReserve);
        await expect
          .poll(() => cp.requests.find(isDeposit) ?? null, { timeout: 180_000, intervals: [2000] })
          .not.toBeNull();
        const req = cp.requests.find(isDeposit)!;
        expect(req.error, 'the deposit was broadcast without an error').toBeUndefined();
        if (typeof req.result !== 'string' || !isHash(req.result)) {
          throw new Error(`the deposit returned no transaction hash: ${String(req.result)}`);
        }
        depositHash = req.result;

        const tx = (req.params as Array<Record<string, string>>)[0];
        if (!tx?.data) throw new Error('the deposit request had no calldata');
        const decoded = decodeFunctionData({ abi: XRESERVE_ABI, data: tx.data as `0x${string}` });
        if (decoded.functionName !== 'depositToRemote') {
          throw new Error(`expected depositToRemote, got ${decoded.functionName}`);
        }
        const [value, remoteDomain, , localToken] = decoded.args;
        expect(value, 'deposit amount').toBe(depositUnits);
        expect(remoteDomain, 'remote domain = Miden').toBe(USDCX_REMOTE_DOMAIN);
        expect(localToken.toLowerCase(), 'deposited token = Arc USDC').toBe(arcUsdc.toLowerCase());
      });

      await steps.step('row_reaches_delivering', async () => {
        // The wallet waits for the real Arc receipt before it moves the row.
        const row = await walletA.latestBridgeReceive('usdcx');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 180_000,
            intervals: [3000]
          })
          .toBe('delivering');
      });

      await steps.step('circle_attests_deposit', async () => {
        await expect
          .poll(
            async () => {
              localRelayer?.assertRunning();
              const attestations = await fetchXReserveAttestations(depositHash).catch(() => []);
              return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
            },
            { timeout: ATTESTATION_TIMEOUT_MS, intervals: [15_000] }
          )
          .toBe(true);
      });

      await steps.step('relayer_mints_and_wallet_claims', async () => {
        // The relayer submits the mint note, the faucet consumes it in a later block,
        // and the minted note then shows in the wallet's Pending list.
        localRelayer?.assertRunning();
        await walletA.claimAllNotes(MINT_AND_CLAIM_TIMEOUT_MS, faucetAccountId ? [faucetAccountId] : []);
      });

      await steps.step('assert_balance', async () => {
        // A new wallet starts at zero, and the claim pays its fee in USDCx out of the
        // deposit. The fee is not a fixed number, so the lower bound is half the deposit:
        // a mint of the wrong amount, or no mint, fails it.
        const deposited = Number(depositAmount);
        const balance = await walletA.waitForBalanceAbove(deposited / 2, 180_000, undefined, 'USDCX');
        expect(balance, 'no more than the deposit').toBeLessThanOrEqual(deposited);
      });
    } finally {
      if (localRelayer) {
        await test.info().attach('usdcx-relayer-log', { body: localRelayer.logs, contentType: 'text/plain' });
      }
      await cp.stop();
    }
  });
});
