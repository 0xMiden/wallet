import fs from 'fs';
import path from 'path';
import { decodeFunctionData, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import {
  CIRCLE_USDC_DECIMALS,
  getUsdcxXReserveSource,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { CLAIM_COST_FEE_MULTIPLE, GAS_RESERVE_UNITS, isWorthClaiming } from '../../helpers/usdcx-constants';
import { guardianIdentity, type GuardianIdentity } from '../../helpers/usdcx-guardian';
import { accountHex, boundLandedFee } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import {
  boundedTerm,
  consumeFeePath,
  errorText,
  evidenceJson,
  exactlyOne,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type RunEvidence
} from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import type { IosNativeAsset, IosWalletPage } from '../helpers/ios-wallet-page';
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
 *
 * The run spends real Arc Testnet USDC (the deposit and the gas).
 *
 * Environment:
 *   USDCX_LIVE_EVM_PRIVATE_KEY        required: funded Arc Testnet key (USDC is the gas token too)
 *   USDCX_LIVE_DEPOSIT_AMOUNT         optional, in USDC; default 0.01
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
/** The store caught up within 5.1 s of a move Home (ios-spike-report.md section 4.1). */
const VAULT_MS = 30_000;
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000,
  // the auth read, then 3 tries of /status and /pubkey at 15 s each: /pubkey answered one spike run with a 502 page
  guardianAccount: 150_000
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
const depositAmount = (process.env.USDCX_LIVE_DEPOSIT_AMOUNT ?? '').trim() || '0.01';
const depositUnits = parseUnits(depositAmount, CIRCLE_USDC_DECIMALS);
const arcRpcUrl = ARC_TESTNET.rpcUrls.default.http[0];
const { usdc: arcUsdc, xReserve } = getUsdcxXReserveSource(ARC_TESTNET.id);

function noteIdsOf(row: TransactionRowSnapshot): string[] {
  return [...(row.noteIds ?? []), ...(row.noteId ? [row.noteId] : [])].map(id => id.toLowerCase());
}

/** The hosted Guardian's identity, read up to 3 times: its /pubkey answered one spike run with a 502 page. */
async function hostedGuardian(url: string): Promise<GuardianIdentity> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5_000));
    try {
      return await guardianIdentity(url);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`the hosted Guardian ${url} did not identify itself in 3 tries: ${errorText(last)}`);
}

/**
 * The vault after one transaction, read on Home: exact from the fee its row recorded, or settled with the fee bounded
 * by the chain's base fee when a landed path recorded none (Q5(d)). `credit` is what the transaction added and
 * `debits` all it took besides its fee.
 */
async function settleLedger(
  wallet: IosWalletPage,
  native: IosNativeAsset,
  term: {
    name: string;
    before: bigint;
    credit: bigint;
    debits: bigint;
    row: { id: string; feeAmount?: string; resultReleasedAt?: number };
  }
): Promise<{ vault: bigint; fee: FeeTerm }> {
  const feePath = consumeFeePath(term.row);
  if (feePath.kind === 'result') {
    const expected = term.before + term.credit - term.debits - feePath.fee;
    const terms = ledgerLine([
      ['before', term.before],
      ['credit', term.credit],
      ['debits', term.debits],
      [term.name, feePath.fee]
    ]);
    const vault = await wallet.homeVaultBaseUnits(
      native.tokenId,
      units => units === expected,
      VAULT_MS,
      `${expected} (${terms})`
    );
    return { vault, fee: { name: term.name, amount: feePath.fee, kind: 'exact' } };
  }
  await wallet.navigateHome();
  const vault = await readSettledChange(() => wallet.readVaultBaseUnits(native.tokenId), term.before, {
    timeoutMs: VAULT_MS,
    intervalMs: 2_000
  });
  const bound = boundLandedFee({
    vaultDelta: term.before - vault,
    knownTerms: term.debits - term.credit,
    baseFee: native.baseFee
  });
  return { vault, fee: boundedTerm(term.name, bound) };
}

/** The evidence JSON; throws rather than write a key or the onboarding password the bypass leaves in location.href. */
function evidenceBody(evidence: RunEvidence, secrets: readonly string[]): string {
  const body = evidenceJson(evidence, secrets);
  if (/[?&]password=/.test(body)) {
    throw new Error('the evidence would carry the onboarding password, so it was not written');
  }
  return body;
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

  test('deposit USDC via the real UI, Circle attests, the relayer mints, the Guardian account claims', async ({
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
    let addressA: string;
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
              const attestations = await fetchXReserveAttestations(depositHash).catch(() => []);
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
      await step('assert_guardian_account', BUDGET.guardianAccount, async () => {
        // The auth structure shows the deposit landed on, and was claimed by, a Guardian account, not a single-sig
        // one, so this spec cannot quietly go back to testing the single-sig path.
        const auth = await walletA.getGuardianAuthInfo(addressA);
        expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
        expect(auth.signerCommitments.length, 'a fresh Guardian account has 2 signers (hot, cold)').toBe(2);
        expect(auth.procedureThresholds.update_guardian, 'update_guardian is hardened to threshold 2').toBe(2);
        const hosted = await hostedGuardian(envConfig.guardianUrl);
        evidence.guardian = {
          url: hosted.url,
          version: hosted.version,
          gitCommit: hosted.gitCommit,
          commitment: hosted.commitment
        };
        // The iOS build picks its Guardian itself, so this also proves it is the hosted one the run identified.
        expect(
          `0x${(auth.guardianCommitment ?? '').replace(/^0x/i, '').toLowerCase()}`,
          `the account's Guardian commitment against ${hosted.url}/pubkey`
        ).toBe(hosted.commitment);
      });
    } finally {
      if (localRelayer) {
        await test.info().attach('usdcx-relayer-log', { body: localRelayer.logs, contentType: 'text/plain' });
      }
      await cp.stop();
      // In the run's artifact directory, which the nightly uploads (test-results-ios/).
      const evidencePath = path.join(steps.outputDir, 'usdcx-live-ios-evidence.json');
      fs.mkdirSync(steps.outputDir, { recursive: true });
      fs.writeFileSync(evidencePath, evidenceBody(evidence, secrets));
      await test.info().attach('usdcx-live-ios-evidence.json', { path: evidencePath, contentType: 'application/json' });
    }
  });
});
