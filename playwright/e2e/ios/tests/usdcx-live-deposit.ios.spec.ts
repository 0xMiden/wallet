import fs from 'fs';
import path from 'path';
import { decodeFunctionData, formatUnits, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS, XRESERVE_ABI } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus } from '../../helpers/history';
import { USDCX_REMOTE_DOMAIN, getUsdcxXReserveSource } from '../../helpers/usdcx-config';
import { CLAIM_COST_FEE_MULTIPLE, GAS_RESERVE_UNITS, isWorthClaiming } from '../../helpers/usdcx-constants';
import type { PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import { ROUNDTRIP_DEPOSIT_UNITS } from '../../helpers/usdcx-roundtrip-funding';
import { exactlyOne, namedSteps, newRunEvidence, PhaseTimeline, pollUntil } from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import {
  assertHostedGuardianAccount,
  burnBackToDepositKey,
  evidenceBody,
  noteIdsOf,
  settleLedger
} from '../helpers/usdcx-live';
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
 *   6. The faucet mints, and the wallet claims the note on its own: USDCx is testnet's native asset,
 *      which the wallet auto-claims, so it never waits in Pending. The wallet is a Guardian account, so
 *      the claim is a consume the hosted testnet Guardian co-signs, and the spec checks the account's
 *      auth structure afterwards.
 *   7. Only then the burn: the wallet burns 2 USDCx, or 3 after an optional faucet grant, through Send to
 *      Arc Testnet, back to the funded key's own address. The run fails unless Circle pays that key within 10
 *      minutes of the faucet consuming the burn (one GatewayMinter AttestationUsed log that carries the burn note id
 *      and adds exactly its value to the key's balance, read right before the burn) and the wallet confirms the
 *      payout itself: the row's destination balance, then the History pill.
 *
 * The default deposit is 2.2 USDC. A failed optional grant leaves enough for the return burn and fees.
 * Without grants, repeated runs spend the fee reserve and payout fees from the EVM key.
 *
 * Environment:
 *   USDCX_LIVE_EVM_PRIVATE_KEY        required: funded Arc Testnet key (USDC is the gas token too)
 *   USDCX_LIVE_DEPOSIT_AMOUNT         optional, in USDC; default 2.2
 *
 * To test a relayer build before it is deployed, set these too and the spec starts
 * that relayer as a local process (all are then required):
 *   USDCX_RELAYER_ACCOUNT_ID          funded Miden account that creates the mint notes
 *   USDCX_FAUCET_ACCOUNT_ID           the USDCx faucet Circle's Miden domain mints from
 *   USDCX_RELAYER_DATA_DIR            holds `keystore/` with that account's key
 *   USDCX_CIRCLE_ATTESTER_PUBLIC_KEY  the key Circle signs deposit attestations with
 * The spec skips when a required variable is unset, and names it.
 *
 * Build the app WITHOUT `E2E_EVM_RPC_URL`, so its Arc reads go to the real RPC.
 */

const ATTESTATION_TIMEOUT_MS = 20 * 60_000;
const MINT_AND_CLAIM_TIMEOUT_MS = 15 * 60_000;
// #1405: a fast round trip can go from submitting straight to received, so ready is recorded, never required.
const DEPOSIT_PHASES = ['submitting', 'delivering', 'ready', 'received'];
/** Deposit-leg step budgets: each a small multiple of the slowest spike run or CI run 38109117552. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000
};

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
const depositAmount =
  (process.env.USDCX_LIVE_DEPOSIT_AMOUNT ?? '').trim() || formatUnits(ROUNDTRIP_DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS);
const depositUnits = parseUnits(depositAmount, CIRCLE_USDC_DECIMALS);
if (depositUnits < ROUNDTRIP_DEPOSIT_UNITS) {
  throw new Error('The full round trip needs a deposit of at least 2.2 USDC');
}
const arcRpcUrl = ARC_TESTNET.rpcUrls.default.http[0];
const { usdc: arcUsdc, xReserve, attestationApi } = getUsdcxXReserveSource(ARC_TESTNET.id);

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

  test('deposit USDC through the UI and claim it, then burn USDCx back to the deposit key and Circle pays it', async ({
    walletA,
    walletB,
    steps,
    envConfig
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
    let addressA = '';
    const step = namedSteps(steps);
    const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const evidence = newRunEvidence('usdcx-live-ios');
    // evidenceJson refuses to write any of these.
    const secrets: string[] = [evmPrivateKey];
    const depositPhases = new PhaseTimeline('deposit row', DEPOSIT_PHASES);

    const sentTo = (address: string) => (r: WcRequestLog) =>
      r.method === 'eth_sendTransaction' &&
      (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === address.toLowerCase();
    // A failed CDP read (an inspector reattach) is retried, as expect.poll did; a failed row fails at once.
    const depositPhase = async (): Promise<string | undefined> => {
      const raw = await walletA.getBridgeReceiveState(bridgeTxId).catch(() => undefined);
      if (raw === undefined) return undefined;
      const state = parseBridgeReceiveState(raw);
      depositPhases.record(state.phase, Date.now());
      if (state.phase === 'failed') {
        throw new Error(`the deposit row failed: ${state.error ?? state.displayMessage ?? 'no error recorded'}`);
      }
      return state.phase;
    };

    await steps.step('preflight_arc', async () => {
      // Fail here, with the cause, instead of after the wallet prompts for a deposit that cannot pass.
      const balance = await readArcUsdc(evmAddress, arc);
      expect(balance, `Arc USDC of ${evmAddress}: the deposit plus its approve and deposit gas`).toBeGreaterThanOrEqual(
        depositUnits + GAS_RESERVE_UNITS
      );
      // Withdrawals are checked before the burn, not here: a pause there must not hide this leg's result.
      const state = await readXReserveDomainState(arc);
      expect(
        { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
        `xReserve domain ${USDCX_REMOTE_DOMAIN}, read on ${arcHost(state.endpoint)}`
      ).toEqual({ registered: true, paused: false, depositsPaused: false });
    });

    await steps.step('create_wallet', async () => {
      ({ address: addressA } = await walletA.createGuardianWallet());
      await walletB.createNewWallet(); // fixture requires both sims up; B takes no part
    });

    try {
      // Inside the try, so a failure here still writes the evidence.
      const { native, recipient } = await step('native_asset', BUDGET.nativeAsset, async () => {
        evidence.ids.wallet = addressA;
        const read = await walletA.nativeAsset();
        // The wallet claims a mint unattended only above base fee x 30, and a dispatch sets the amount: a smaller
        // deposit would sit unclaimed until relayer_mints_and_wallet_claims gave up 15 min later.
        if (!isWorthClaiming(depositUnits, read.baseFee)) {
          throw new Error(
            `USDCX_LIVE_DEPOSIT_AMOUNT ${depositAmount} (${depositUnits} base units) does not exceed the wallet's ` +
              `unattended claim floor, base fee ${read.baseFee} x ${CLAIM_COST_FEE_MULTIPLE}`
          );
        }
        // The deposit's remoteRecipient for this account, as the faucet decodes it.
        return { native: read, recipient: midenAccountHexToXReserveRecipient(await accountHex(addressA)) };
      });
      evidence.ids.native = native.tokenId;
      await steps.step('connect_evm', async () => {
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      await steps.step('deposit_via_ui', async () => {
        // The screen opens on Circle's USDC, the token xReserve takes, and it has one
        // route; the pick names the token the deposit needs.
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
        const [value, remoteDomain, remoteRecipient, localToken, maxFee, hookData] = decoded.args;
        expect(value, 'deposit amount').toBe(depositUnits);
        expect(remoteDomain, 'remote domain = Miden').toBe(USDCX_REMOTE_DOMAIN);
        expect(localToken.toLowerCase(), 'deposited token = Arc USDC').toBe(arcUsdc.toLowerCase());
        // The faucet mints to remoteRecipient, so a wrong one strands the deposit; the wallet pays no fee and no hook.
        expect(
          { remoteRecipient: remoteRecipient.toLowerCase(), maxFee, hookData },
          'the recipient, maxFee and hookData the counterparty signed'
        ).toEqual({ remoteRecipient: recipient, maxFee: 0n, hookData: '0x' });
        evidence.hashes.deposit = depositHash;
      });

      await steps.step('row_reaches_delivering', async () => {
        // The wallet waits for the real Arc receipt before it moves the row. Circle, the relayer and the auto-claim can
        // all finish before that receipt is read, and the phase only moves forward, so the row may go from
        // `submitting` straight to `received`; any phase from `delivering` on means the deposit left Arc.
        const row = await walletA.latestBridgeReceive('usdcx');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        evidence.ids.depositRow = bridgeTxId;
        depositPhases.record(row!.phase, Date.now());
        await pollUntil(
          'the deposit row leaving submitting',
          depositPhase,
          phase => phase !== undefined && phase !== 'submitting',
          { timeoutMs: 180_000, intervalMs: 3_000 }
        );
        // The deposit screen wrote the recipient it signed for at the row's first phase write.
        const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
        expect(state.usdcxRemoteRecipient, "the deposit row's xReserve recipient").toBe(recipient);
      });

      await steps.step('circle_attests_deposit', async () => {
        await expect
          .poll(
            async () => {
              localRelayer?.assertRunning();
              const attestations = await fetchXReserveAttestations(depositHash, { baseUrl: attestationApi }).catch(
                () => []
              );
              return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
            },
            { timeout: ATTESTATION_TIMEOUT_MS, intervals: [15_000] }
          )
          .toBe(true);
      });

      await steps.step('relayer_mints_and_wallet_claims', async () => {
        // The relayer submits the mint note and the faucet consumes it in a later block. The wallet auto-claims the
        // minted USDCx (testnet's native asset) and moves this deposit's row to `received` only once the consume it
        // matched to the deposit has completed.
        await pollUntil(
          'the relayer mint and the wallet claim',
          async () => {
            localRelayer?.assertRunning();
            return depositPhase();
          },
          phase => phase === 'received',
          { timeoutMs: MINT_AND_CLAIM_TIMEOUT_MS, intervalMs: 5_000 }
        );
        depositPhases.assertMonotone();
        evidence.phases.deposit = depositPhases.samples();
      });

      const depositVault = await step('deposit_vault', BUDGET.depositVault, async () => {
        const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
        const claim = exactlyOne(
          (await walletA.readTransactionRows({ type: 'consume' })).filter(row => row.status === TxStatus.Completed),
          'Completed consume on the fresh wallet, the claim of the minted note',
          describeTransactionRow
        );
        expect(
          state.midenNoteId === undefined || noteIdsOf(claim).includes(state.midenNoteId.toLowerCase()),
          `the claim ${claim.id} consumed the mint note ${state.midenNoteId} the deposit row names`
        ).toBe(true);
        // A new wallet starts at zero, so the vault is the mint less the fee the claim's row recorded.
        const settled = await settleLedger(walletA, native, {
          name: 'f2',
          before: 0n,
          credit: depositUnits,
          debits: 0n,
          row: claim
        });
        evidence.ids.mintNote = state.midenNoteId ?? 'not recorded';
        evidence.ids.mintConsume = claim.id;
        evidence.fees.push(settled.fee);
        return settled.vault;
      });
      evidence.notes.push(`vault after the claim ${depositVault}`);

      // The identity is read here, after the deposit leg, so a Guardian endpoint glitch cannot stop that leg running.
      const identity = await assertHostedGuardianAccount(step, walletA, {
        address: addressA,
        guardianUrl: envConfig.guardianUrl,
        evidence
      });

      // R20: the burn pays the deposit key back, after the deposit leg. It comes last: Circle's
      // Arc payouts have run hours late, and this order lets one redden the run only after the deposit leg passed.
      const depositKey: PayoutKey = {
        key: { address: evmAddress, privateKey: `0x${evmPrivateKey.replace(/^0x/i, '')}` },
        role: 'deposit',
        label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`
      };
      await burnBackToDepositKey({
        step,
        wallet: walletA,
        address: addressA,
        native,
        envConfig,
        identity,
        vaultBefore: depositVault,
        arc,
        depositKey,
        evidence,
        secrets,
        screenshotDir: path.join(steps.outputDir, 'usdcx-burn')
      });
    } finally {
      if (localRelayer) {
        await test.info().attach('usdcx-relayer-log', { body: localRelayer.logs, contentType: 'text/plain' });
      }
      await cp.stop();
      // In the run's artifact directory, which the job uploads (test-results-ios/).
      const evidencePath = path.join(steps.outputDir, 'usdcx-live-ios-evidence.json');
      fs.mkdirSync(steps.outputDir, { recursive: true });
      fs.writeFileSync(evidencePath, evidenceBody(evidence, secrets));
      await test.info().attach('usdcx-live-ios-evidence.json', { path: evidencePath, contentType: 'application/json' });
    }
  });
});
