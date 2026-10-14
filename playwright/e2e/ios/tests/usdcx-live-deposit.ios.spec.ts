import { USDCX_REMOTE_DOMAIN, getUsdcxXReserveSource } from '../../helpers/usdcx-config';
import fs from 'fs';
import path from 'path';
import { decodeFunctionData, formatUnits, isHash, isHex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import { CIRCLE_USDC_DECIMALS, XRESERVE_ABI } from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { enText, parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../../helpers/public-faucet';
import { waitForPublicNoteCommitment } from '../../helpers/public-note-commitment';
import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_READ_STEP_BUDGET_MS,
  BURN_UNITS,
  CLAIM_COST_FEE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GRANT_UNITS,
  isWorthClaiming,
  PAYOUT_TIMEOUT_MS,
  USDCX_DECIMALS,
  WALLET_CONFIRM_TIMEOUT_MS
} from '../../helpers/usdcx-constants';
import {
  assertNoGuardianOpInFlight,
  guardianFailureContext,
  guardianIdentity,
  type GuardianIdentity
} from '../../helpers/usdcx-guardian';
import { payoutLeg, waitForWalletPayoutConfirmation, type PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex, boundLandedFee, burnEvidence, burnOutputs, note, nullifier } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import {
  boundedTerm,
  burnCompletionPath,
  burnOutputNoteProblem,
  consumeFeePath,
  describePage,
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
  type RunEvidence,
  type StepContext
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
 *   7. Only then the burn: the wallet takes USDCx from the public faucet and burns 1 USDCx through Send, with the
 *      Arc Testnet chip, back to the funded key's own address. The run fails unless Circle pays that key within 10
 *      minutes of the faucet consuming the burn (one GatewayMinter AttestationUsed log that carries the burn note id
 *      and adds exactly its value to the key's balance, read right before the burn) and the wallet confirms the
 *      payout itself: the row's destination balance, then the History pill.
 *
 * The run spends public faucet USDCx and real Arc Testnet USDC (the deposit and the gas). At the default 0.01 USDC
 * deposit the payout of about 0.98 USDC more than refills that, so the funded key needs no top-up
 * (playwright/e2e/docs/e2e-architecture.md, section 8).
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
  guardianAccount: 150_000,
  // each Arc read step outlasts a stall on every endpoint before the last one answers (R24)
  arcState: ARC_READ_STEP_BUDGET_MS,
  // spike 1.5 s for PoW and submit; the faucet helper waits out 429s for up to 180 s, then the 120 s commitment
  grant: 360_000,
  // spike 18 s to Completed; floor: a Guardian co-signed consume proved locally on a CI simulator
  grantConsumed: 300_000,
  // the commit lands a block or two after the consume completed, then GUARDIAN_SETTLE_MS
  settle: 120_000,
  keySnapshot: ARC_READ_STEP_BUDGET_MS,
  // spike 4.6 s; holds the driver's 60 s review-ready and 60 s submit polls
  burnViaSend: 240_000,
  // spike 4.8 s; floor: a local prove when the remote prover misses its ~10 s deadline
  burnCompleted: 300_000,
  // spike 14 s from Completed to the faucet's consume; floor: the faucet's network transaction
  burnConsumed: 300_000,
  // D3: the consume plus 10 min, plus the log scan
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  // spike 3.4 s; plus the details page and its receiving-tx link
  walletConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000
};
// A burn skips the wallet's settlement gate (#312) and is not requeued on a 409, so the hosted Guardian must have
// promoted the grant consume's candidate first; it runs a 3 s pass once a transaction commits, and the spike's 20 s
// after the consume gave no 409 on 3 burns.
const GUARDIAN_SETTLE_MS = 20_000;
// consuming lasts about a block and the spike never sampled it, so it is recorded, never required.
const BURN_PHASES = ['pending', 'consuming', 'confirmed'];
const RECEIVING_TX_LINK_MS = 15_000;

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
      const identity = await step('assert_guardian_account', BUDGET.guardianAccount, async () => {
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
        return hosted;
      });

      // The burn half comes last: Circle's Arc payouts have run hours late, and this order lets one redden the run only
      // after the deposit leg above passed and was reported.
      const where: StepContext = async () =>
        describePage(await walletA.evalJs<string>('return location.href;'), () =>
          walletA.evalJs<string>('return document.visibilityState;')
        );
      const onGuardian: StepContext = () => guardianFailureContext(identity);
      const faucetUrl = publicFaucetApiUrl(envConfig.name);
      if (!faucetUrl) throw new Error(`no public faucet for ${envConfig.name}`);

      // Before the grant, so a bridge that cannot pay this burn out costs no grant and leaves no deferred payout.
      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
        ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
        return state;
      });

      const grant = await step('grant', BUDGET.grant, async () => {
        // R19: one grant from the 10 USDCx tier; asking for no amount gets the largest, 100 USDCx.
        const { noteId } = await mintFromPublicFaucet(faucetUrl, addressA, GRANT_UNITS);
        if (!isHex(noteId)) throw new Error(`the public faucet answered note id ${noteId}`);
        await waitForPublicNoteCommitment(envConfig.rpcUrl, noteId, 120_000);
        const asset = exactlyOne(
          (await note(envConfig.rpcUrl, noteId)).assets,
          'asset in the grant note',
          item => `${item.amount} of ${item.faucetHex}`
        );
        expect(asset.faucetHex.toLowerCase(), 'the grant is the native asset').toBe(
          (await accountHex(native.tokenId)).toLowerCase()
        );
        // An explicit tier is never asked again at a cap, so a faucet that dropped the tier fails here, named.
        expect(asset.amount, 'the faucet granted the tier it was asked for').toBe(GRANT_UNITS);
        return { noteId, units: asset.amount };
      });
      evidence.ids.grantNote = grant.noteId;

      const grantedVault = await step(
        'grant_consumed',
        BUDGET.grantConsumed,
        async () => {
          const claim = await pollUntil(
            'the wallet auto-consuming the grant',
            async () =>
              (await walletA.readTransactionRows({ type: 'consume' })).find(row =>
                noteIdsOf(row).includes(grant.noteId.toLowerCase())
              ),
            row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
            { timeoutMs: BUDGET.grantConsumed - VAULT_MS - 30_000, intervalMs: 3_000, describe: () => where() }
          );
          if (claim?.status !== TxStatus.Completed) {
            throw new Error(`the grant's consume failed: ${claim ? describeTransactionRow(claim) : 'no row'}`);
          }
          const settled = await settleLedger(walletA, native, {
            name: 'f0',
            before: depositVault,
            credit: grant.units,
            debits: 0n,
            row: claim
          });
          evidence.ids.grantConsume = claim.id;
          evidence.fees.push(settled.fee);
          return settled.vault;
        },
        onGuardian
      );

      evidence.settleMs.grant = await step(
        'settle_grant',
        BUDGET.settle,
        async () => {
          const started = Date.now();
          await pollUntil(
            'the grant consume committing',
            () => nullifier(envConfig.rpcUrl, grant.noteId),
            read => read.committed,
            { timeoutMs: BUDGET.settle - GUARDIAN_SETTLE_MS - 10_000, intervalMs: 3_000 }
          );
          await walletA.delay(GUARDIAN_SETTLE_MS);
          assertNoGuardianOpInFlight(await walletA.readTransactionRows(), addressA);
          return Date.now() - started;
        },
        onGuardian
      );

      // R20: the burn pays the deposit key back, so each run refills what its deposit leg spent. The leg reads the key
      // right before the burn, after the deposit's approve and deposit were mined, and its payout gate counts only what
      // this burn adds above that read (R21, R22); the label names the key Circle pays in every payout failure.
      const depositKey: PayoutKey = {
        key: { address: evmAddress, privateKey: `0x${evmPrivateKey.replace(/^0x/i, '')}` },
        role: 'deposit',
        label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`
      };
      const { key, snapshot, waitForPayout } = await payoutLeg(step, {
        takeKey: () => depositKey,
        arc,
        budget: BUDGET,
        evidence,
        secrets
      });

      const submission = await step(
        'burn_via_send',
        BUDGET.burnViaSend,
        signal =>
          walletA.burnUsdcxViaSendFlow({
            destAddress: key.address,
            amount: formatUnits(BURN_UNITS, USDCX_DECIMALS),
            nativeTokenId: native.tokenId,
            nativeSymbol: native.symbol,
            screenshotDir: path.join(steps.outputDir, 'usdcx-burn'),
            // R26: an overrun step never submits the burn after its test failed.
            signal
          }),
        onGuardian
      );
      evidence.ids.burnRow = submission.rowId;
      evidence.notes.push(
        `review ${submission.reviewRoute}`,
        `generating ${submission.generatingRoute}`,
        `chips pressed before the Arc click: ${submission.defaultPressed.join(', ') || 'none'}`
      );

      const burned = await step(
        'burn_completed',
        BUDGET.burnCompleted,
        async () => {
          const { row, stages } = await walletA.waitForBurnCompleted(submission.rowId, BUDGET.burnCompleted - 15_000);
          const usdcxBurn = row.extraInputs?.usdcxBurn;
          const burnNoteId = usdcxBurn?.noteId ?? '';
          if (!isHex(burnNoteId)) {
            throw new Error(`burn row ${row.id} names no burn note: ${JSON.stringify(row.extraInputs)}`);
          }
          expect(
            {
              provider: row.extraInputs?.provider,
              to: row.extraInputs?.destinationAddress?.toLowerCase(),
              chain: row.extraInputs?.destinationNetwork,
              domain: usdcxBurn?.destinationDomain,
              before: usdcxBurn?.destinationBalanceBefore?.balance
            },
            // Anything that paid into or spent from the key between the two reads breaks the payout's delta.
            `burn row ${row.id}; the leg read ${snapshot.balance} on the key at Arc block ${snapshot.blockNumber} ` +
              'right before the burn'
          ).toEqual({
            provider: 'usdcx',
            to: key.address.toLowerCase(),
            chain: ARC_CHAIN_ID,
            domain: ARC_CIRCLE_DOMAIN,
            // The wallet's own snapshot of the key must be the one the payout gate counts from.
            before: snapshot.balance.toString()
          });
          evidence.notes.push(`burn stages ${JSON.stringify(stages)}`);
          return { row, burnNoteId, arcFromBlock: BigInt(usdcxBurn?.destinationBalanceBefore?.blockNumber ?? '0') };
        },
        onGuardian
      );
      evidence.ids.burnNote = burned.burnNoteId;
      evidence.hashes.burnTransaction = burned.row.transactionId ?? 'none';

      const consumed = await step(
        'burn_consumed',
        BUDGET.burnConsumed,
        async () => {
          // The wallet's watcher moves the phase only while a wallet page is visible, so the run waits on Home.
          await walletA.navigateHome();
          const phases = new PhaseTimeline('burn row', BURN_PHASES);
          await pollUntil(
            'the faucet consuming the burn note',
            async () => {
              const rows = await walletA.readBridgedSendRows();
              const phase = rows.find(row => row.id === burned.row.id)?.extraInputs?.usdcxBurn?.phase;
              phases.record(phase, Date.now());
              if (phase === 'discarded') throw new Error(`the node discarded burn note ${burned.burnNoteId}`);
              return phase;
            },
            phase => phase === 'confirmed',
            { timeoutMs: BUDGET.burnConsumed - VAULT_MS - 60_000, intervalMs: 3_000, describe: () => where() }
          );
          phases.assertMonotone();
          evidence.phases.burn = phases.samples();
          const oracle = await burnEvidence(envConfig.rpcUrl, {
            faucetBech32: native.tokenId,
            noteId: burned.burnNoteId,
            senderBech32: addressA,
            domain: ARC_CIRCLE_DOMAIN,
            recipient: key.address,
            amount: BURN_UNITS
          });
          // A missing fee_schedule entry would read as a zero sponsorship and hide inside a bounded fee.
          if (oracle.sponsorshipUnits <= 0n) {
            throw new Error(`the faucet's fee_schedule names no sponsorship for burn root ${oracle.scriptRoot}`);
          }
          const completion = burnCompletionPath(burned.row);
          if (completion.kind === 'result') {
            const outputs = await burnOutputs({
              resultBytesBase64: completion.resultBytes,
              burnNoteId: burned.burnNoteId,
              faucetBech32: native.tokenId
            });
            const read = ledgerLine([
              ['N', outputs.burn.amount],
              ['s', outputs.sponsorship.amount],
              ['f1', outputs.fee.amount]
            ]);
            const want = ledgerLine([
              ['N', BURN_UNITS],
              ['s', oracle.sponsorshipUnits],
              ['f1', BigInt(burned.row.feeAmount ?? '-1')]
            ]);
            if (read !== want) throw new Error(`the burn's outputs by role read ${read}, expected ${want}`);
          }
          // Only the local completion path lists the burn note; a landed one rests on the oracle above (R24).
          const unlisted = burnOutputNoteProblem(completion, burned.row, burned.burnNoteId);
          if (unlisted !== undefined) throw new Error(unlisted);
          const settled = await settleLedger(walletA, native, {
            name: 'f1',
            before: grantedVault,
            credit: 0n,
            debits: BURN_UNITS + oracle.sponsorshipUnits,
            row: burned.row
          });
          evidence.fees.push(settled.fee, { name: 's', amount: oracle.sponsorshipUnits, kind: 'exact' });
          evidence.notes.push(
            `burn ledger ${ledgerLine([
              ['V1', grantedVault],
              ['N', BURN_UNITS],
              ['s', oracle.sponsorshipUnits],
              [settled.fee.name, settled.fee.amount],
              ['V2', settled.vault]
            ])}`
          );
          return oracle;
        },
        onGuardian
      );

      const consumeTsMs = consumed.consumeTimestampSec * 1_000;
      // D3 in delta mode, a hard gate (the leg's payout step): exactly one AttestationUsed log whose gatewayMint
      // carries the burn note id, by the consume plus 10 min, that adds exactly its value to the key's balance above
      // the snapshot.
      const payout = await waitForPayout({ burnNoteId: burned.burnNoteId, oracle: consumed }, xreserve.depositor);

      // Q6, a hard gate: the wallet's own destination check confirms the payout Circle made.
      const confirmedAt = await step('wallet_confirms_payout', BUDGET.walletConfirmed, async () => {
        await walletA.navigateHome();
        const at = await waitForWalletPayoutConfirmation({
          readRows: () => walletA.readBridgedSendRows(),
          rowId: burned.row.id,
          arcFromBlock: burned.arcFromBlock,
          payout,
          key,
          arc,
          where,
          evidence
        });
        await walletA.openTransactionDetails(burned.row.id);
        const pills: string[] = [];
        await pollUntil(
          'the History pill reading Confirmed',
          async () => {
            const { pill } = await walletA.transactionDetailsView(burned.row.id);
            if (pill !== null && pills[pills.length - 1] !== pill) pills.push(pill);
            return pill;
          },
          pill => pill === enText('confirmed'),
          { timeoutMs: 30_000, intervalMs: 1_000 }
        );
        evidence.notes.push(`history pill ${pills.join(' then ')}`);
        // The receiving-tx link is a best-effort RPC match (CLAUDE.md), so only a link to another transaction fails.
        const linkDeadline = Date.now() + RECEIVING_TX_LINK_MS;
        let links = (await walletA.transactionDetailsView(burned.row.id)).arcTxLinks;
        while (links.length === 0 && Date.now() < linkDeadline) {
          await walletA.delay(1_000);
          links = (await walletA.transactionDetailsView(burned.row.id)).arcTxLinks;
        }
        expect(
          links.filter(href => !href.toLowerCase().endsWith(`/tx/${payout.transactionHash.toLowerCase()}`)),
          'receiving-tx links that name another transaction'
        ).toEqual([]);
        evidence.notes.push(
          links.length === 0
            ? 'receiving-tx link did not render within 15 s'
            : 'receiving-tx link is the AttestationUsed transaction'
        );
        await walletA.navigateHome();
        return at;
      });
      evidence.latenciesMs.payoutToWalletConfirmation = confirmedAt - (consumeTsMs + payout.latencyMs);
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
