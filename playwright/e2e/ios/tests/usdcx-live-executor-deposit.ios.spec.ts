import fs from 'fs';
import path from 'path';
import { formatUnits, isHash, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  ERC20_ABI,
  onFirstEndpoint,
  readXReserveDomainState,
  waitForXReserveAttestation,
  type ArcReadDeps
} from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState, type BridgeReceiveStateSnapshot } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus } from '../../helpers/history';
import { createL2Sender } from '../../helpers/l2-sender';
import { confirmArcForward, confirmL2Burn, waitForIrisForward } from '../../helpers/usdcx-cctp-proof';
import {
  ARC_ATTESTATION_API,
  ARC_READ_STEP_BUDGET_MS,
  ARC_USDC,
  CLAIM_COST_FEE_MULTIPLE,
  DEPOSIT_UNITS,
  isWorthClaiming,
  L2_BRIDGE_IN_SOURCES,
  redactProjectId,
  USDCX_REMOTE_DOMAIN
} from '../../helpers/usdcx-constants';
import { executorDepositRequests } from '../../helpers/usdcx-executor-requests';
import {
  l2KeyShortfall,
  l2Reads,
  payoutKeyProblem,
  quoteL2Deposit,
  readL2KeyFunds
} from '../../helpers/usdcx-l2-deposit';
import type { PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex, bareId, deriveUsdcxMintNoteId, waitForUsdcxMint } from '../../helpers/usdcx-miden';
import {
  errorText,
  exactlyOne,
  jsonObject,
  jsonString,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil
} from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import {
  assertHostedGuardianAccount,
  burnBackToDepositKey,
  evidenceBody,
  settleLedger,
  VAULT_MS
} from '../helpers/usdcx-live';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';

/**
 * Bridge-IN on the executor route against the LIVE networks, one test per source chain the wallet offers there
 * (L2_BRIDGE_IN_SOURCES: Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia), to Miden testnet through Circle's CCTP
 * forward to Arc. Nothing on the path is a double:
 *   1. Real Reown pairing: the app's native Reown and a headless counterparty that approves the source chain alone.
 *   2. Real UI: Receive, Cross Chain, Circle USDC, the source network, the amount, the route, Confirm.
 *   3. Real deposit: the wallet's runUsdcxExecutorDeposit asks the key to approve the fee entry point when its
 *      allowance is short, then to sign the forwarded burn; the counterparty signs through createL2Sender.
 *   4. Circle attests the burn and forwards it to Arc, its executor deposits into xReserve, Circle attests that
 *      deposit, the deployed relayer mints and the wallet claims the mint by itself.
 *   5. Only then the burn half: USDCx from a public faucet grant through Send back to the key's address on the source
 *      chain (2 USDCx to Ethereum Sepolia, 1 elsewhere), passing only once Circle paid that burn there and the wallet
 *      reads Confirmed.
 * Each hop is gated with the extension suite's executor proofs (usdcx-in-l2.spec.ts). The run never executes on Arc:
 * the session approves no Arc chain, so the key cannot be asked to sign there.
 *
 * Environment: USDCX_LIVE_EVM_PRIVATE_KEY, the key E2E USDCx Bridge-IN (live) deposits from, which needs ETH and USDC on
 * each source chain (playwright/e2e/docs/e2e-architecture.md, "The iOS job's key"); the spec skips without it.
 * USDCX_LIVE_SOURCE (base-sepolia, arbitrum-sepolia or sepolia) defines that chain's test alone, as each job of the
 * workflow does; unset, every chain runs, one after another.
 *
 * Build the app WITHOUT `E2E_EVM_RPC_URL`, so its source-chain and Arc reads go to the real RPCs.
 */

const SOURCE_SLUGS = L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout.reviewNetwork);
const SELECTED_SOURCE = (process.env.USDCX_LIVE_SOURCE ?? '').trim();
if (SELECTED_SOURCE !== '' && !SOURCE_SLUGS.includes(SELECTED_SOURCE)) {
  // A typo would otherwise define no test, and the job would only say that it found none.
  throw new Error(`USDCX_LIVE_SOURCE ${SELECTED_SOURCE} names no executor source: ${SOURCE_SLUGS.join(', ')}`);
}
const SOURCES =
  SELECTED_SOURCE === ''
    ? L2_BRIDGE_IN_SOURCES
    : L2_BRIDGE_IN_SOURCES.filter(l2 => l2.payout.reviewNetwork === SELECTED_SOURCE);
// #1405: a fast round trip can go from submitting straight to received, so ready is recorded, never required.
const DEPOSIT_PHASES = ['submitting', 'delivering', 'ready', 'received'];
/**
 * The preflight's fee ceiling, before a wallet exists to quote for: scripts/e2e-real.mjs's L2_BRIDGE_IN_USDC_FLOOR_UNITS
 * assumes the same 0.05 USDC (Circle quoted 0.022404 from Base Sepolia and 0.015638 from Ethereum Sepolia on
 * 2026-10-16). The l2_key step checks the real quote.
 */
const PREFLIGHT_FORWARD_FEE = 50_000n;
const KEY_REFILL = 'a green run of the iOS executor spec pays it back there';
const BUDGET = {
  nativeAsset: 90_000,
  arcState: ARC_READ_STEP_BUDGET_MS,
  l2Key: ARC_READ_STEP_BUDGET_MS + 15_000,
  l2Sender: ARC_READ_STEP_BUDGET_MS,
  depositViaUi: 240_000,
  // The wallet's balance read, Circle's quote, the approve and its receipt on the wallet's own RPC, a second quote,
  // the burn prompt, and the sender's receipt wait and pin before it signs the burn.
  depositBroadcast: 300_000,
  rowDelivering: 180_000,
  check: 30_000,
  sourceBurn: ARC_READ_STEP_BUDGET_MS,
  // A fast transfer forwarded in 8-10 s when probed; Circle falls back to source finality (15-20 min) when its fast
  // allowance runs out, and the wallet tells users about 20 min.
  iris: 1_500_000,
  arcForward: 150_000,
  rowForward: 120_000,
  attest: 120_000,
  mint: 180_000,
  receive: 420_000
};

const evmPrivateKey = (process.env.USDCX_LIVE_EVM_PRIVATE_KEY ?? '').trim();
const keyHex: Hex = `0x${evmPrivateKey.replace(/^0x/i, '')}`;

/** A transaction request's target, lowercase. */
function targetOf(request: WcRequestLog): string | undefined {
  const [tx] = Array.isArray(request.params) ? request.params : [];
  const to: unknown = tx !== null && typeof tx === 'object' ? Reflect.get(tx, 'to') : undefined;
  return typeof to === 'string' ? to.toLowerCase() : undefined;
}

for (const l2 of SOURCES) {
  const chain = l2.payout;
  test.describe(`Bridge-IN deposit from ${chain.networkName} (Circle CCTP forward to Arc, live testnets)`, () => {
    // The worst passing run: the 13 min simulator setup cap, every deposit step at its budget (75.5 min, 25 of them
    // Circle's forward at source finality and about 15 the Reown handshake's retries) and every burn step at its
    // budget (47 min): about 136 min, rounded up.
    test.describe.configure({ mode: 'serial', timeout: 8_400_000 });
    test.skip(
      evmPrivateKey === '' || (process.env.E2E_NETWORK ?? 'testnet') !== 'testnet',
      'requires E2E_NETWORK=testnet and USDCX_LIVE_EVM_PRIVATE_KEY'
    );

    // Before the simulator setup: a key Circle cannot pay on the chain, one short of its ETH or USDC, or a wallet RPC
    // that refuses the chain fails here in seconds, naming what to fix.
    test.beforeAll(async () => {
      const address = privateKeyToAccount(keyHex).address;
      const reads = l2Reads(l2);
      const funds = await readL2KeyFunds(address, reads);
      const problem =
        payoutKeyProblem(chain, address, funds.usdc) ??
        l2KeyShortfall({
          label: chain.label,
          address,
          ...funds,
          units: DEPOSIT_UNITS,
          fee: PREFLIGHT_FORWARD_FEE,
          refill: KEY_REFILL
        });
      if (problem !== undefined) throw new Error(problem);
      try {
        await onFirstEndpoint({ ...reads, endpoints: [chain.walletRpcUrl] }, `${chain.label} head`, client =>
          client.getBlockNumber()
        );
      } catch (error) {
        throw new Error(
          `infra: the wallet reads ${chain.label} through ${chain.walletRpcName}, which did not answer: ` +
            redactProjectId(errorText(error))
        );
      }
    });

    test(`deposit USDC from ${chain.networkName} through the UI, Circle forwards it to Arc and the wallet claims it, then burn USDCx back to the key there`, async ({
      walletA,
      walletB,
      steps,
      envConfig
    }) => {
      const step = namedSteps(steps);
      const evmAddress = privateKeyToAccount(keyHex).address;
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads = l2Reads(l2);
      const evidence = newRunEvidence(`usdcx-live-executor-ios ${chain.reviewNetwork}`);
      // evidenceJson refuses to write any of these.
      const secrets: string[] = [keyHex];
      const depositPhases = new PhaseTimeline('deposit row', DEPOSIT_PHASES);
      let cp: WcCounterparty | undefined;
      let addressA = '';
      let bridgeTxId = '';
      // A failed CDP read (an inspector reattach) reads as not yet; a failed row fails at once.
      const rowState = async (): Promise<BridgeReceiveStateSnapshot | undefined> => {
        const raw = await walletA.getBridgeReceiveState(bridgeTxId).catch(() => undefined);
        if (raw === undefined) return undefined;
        const state = parseBridgeReceiveState(raw);
        depositPhases.record(state.phase, Date.now());
        if (state.phase === 'failed') {
          throw new Error(`the deposit row failed: ${state.error ?? state.displayMessage ?? 'no error recorded'}`);
        }
        return state;
      };

      await steps.step('create_wallet', async () => {
        ({ address: addressA } = await walletA.createGuardianWallet());
        await walletB.createNewWallet(); // fixture requires both sims up; B takes no part
      });

      try {
        // Inside the try, so a failure here still writes the evidence.
        const { native, ids } = await step('native_asset', BUDGET.nativeAsset, async () => {
          evidence.ids.wallet = addressA;
          evidence.ids.sourceChainId = String(chain.chainId);
          const read = await walletA.nativeAsset();
          if (!isWorthClaiming(DEPOSIT_UNITS, read.baseFee)) {
            throw new Error(
              `the ${DEPOSIT_UNITS}-unit deposit does not exceed the wallet's unattended claim floor, base fee ` +
                `${read.baseFee} x ${CLAIM_COST_FEE_MULTIPLE}`
            );
          }
          return {
            native: read,
            ids: {
              accountHex: await accountHex(addressA),
              nativeHex: await accountHex(read.tokenId),
              bare: bareId(addressA),
              nativeBare: bareId(read.tokenId)
            }
          };
        });
        evidence.ids.native = native.tokenId;
        // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
        const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);

        const xreserve = await step('arc_state', BUDGET.arcState, async () => {
          const state = await readXReserveDomainState(arc);
          expect(
            { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
          ).toEqual({ registered: true, paused: false, depositsPaused: false });
          expect(state.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
            midenAccountHexToXReserveRecipient(ids.nativeHex)
          );
          return state;
        });

        const funded = await step('l2_key', BUDGET.l2Key, async () => {
          const funds = await readL2KeyFunds(evmAddress, reads);
          const quote = await quoteL2Deposit(l2, { units: DEPOSIT_UNITS, recipient, depositor: evmAddress });
          const shortfall = l2KeyShortfall({
            label: chain.label,
            address: evmAddress,
            ...funds,
            units: DEPOSIT_UNITS,
            fee: quote.feeTotalAmount,
            refill: KEY_REFILL
          });
          if (shortfall !== undefined) throw new Error(shortfall);
          // With no approve in the deposit, this allowance must have covered the burn (executorDepositRequests).
          const allowance = await onFirstEndpoint(reads, `${chain.label} allowance of ${evmAddress}`, client =>
            client.readContract({
              address: l2.source.usdc,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [evmAddress, l2.source.tokenMessengerWithFees]
            })
          );
          return { funds, fee: quote.feeTotalAmount, allowance };
        });
        evidence.ids.arcKey = evmAddress;
        evidence.ids.arcKeyRole = 'deposit';
        evidence.notes.push(
          `key on ${chain.label}: ${funded.funds.wei} wei, ${funded.funds.usdc} USDC base units, allowance ` +
            `${funded.allowance}, quoted fee ${funded.fee}`
        );

        const sender = await step('l2_sender', BUDGET.l2Sender, () =>
          createL2Sender({
            privateKey: keyHex,
            l2,
            allowedTargets: [l2.source.usdc, l2.source.tokenMessengerWithFees]
          })
        );
        evidence.notes.push(`writes via ${arcHost(sender.endpoint)}`);
        const counterparty = new WcCounterparty({
          privateKey: keyHex,
          rpcUrl: sender.endpoint,
          chainId: chain.chainId,
          sessionChainIds: [chain.chainId],
          send: (tx, signal) => sender.send(tx, signal)
        });
        cp = counterparty;

        await steps.step('connect_evm', async () => {
          await counterparty.connectWithRetry(
            () => walletA.reownConnectUri(),
            async () => (await walletA.reownState()).connected
          );
        });

        await step('deposit_via_ui', BUDGET.depositViaUi, async () => {
          await walletA.openBridgeDeposit();
          await walletA.selectBridgeToken('CIRCLE_USDC');
          await walletA.selectBridgeNetwork(chain.reviewNetwork, chain.networkName);
          await walletA.enterBridgeAmount(formatUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS));
          await walletA.confirmBridgeRouteUsdcx(60_000);
          await walletA.confirmBridgeDeposit();
        });
        const submittedAt = Date.now();

        const burnHash = await step('deposit_broadcast', BUDGET.depositBroadcast, async (): Promise<Hash> => {
          const fee = l2.source.tokenMessengerWithFees.toLowerCase();
          const request = await pollUntil(
            'the forwarded burn the wallet asked the key to sign',
            async () => {
              const refused = counterparty.requests.find(entry => entry.error !== undefined);
              if (refused) {
                throw new Error(`the key's counterparty answered ${refused.method} with an error: ${refused.error}`);
              }
              const row = await walletA.latestBridgeReceive('usdcx').catch(() => null);
              if (row?.phase === 'failed') {
                throw new Error(
                  `the deposit row failed before the burn: ${row.error ?? row.displayMessage ?? 'no error'}`
                );
              }
              return counterparty.requests.find(
                entry => entry.method === 'eth_sendTransaction' && targetOf(entry) === fee
              );
            },
            found => found !== undefined,
            {
              timeoutMs: BUDGET.depositBroadcast - 15_000,
              intervalMs: 2_000,
              describe: async () =>
                `requests so far ${JSON.stringify(
                  counterparty.requests.map(entry => ({
                    method: entry.method,
                    chainId: entry.chainId,
                    to: targetOf(entry)
                  }))
                )}`
            }
          );
          const hash = request?.result;
          if (typeof hash !== 'string' || !isHash(hash)) throw new Error(`the burn returned no hash: ${String(hash)}`);
          return hash;
        });
        evidence.hashes.burn = burnHash;

        const recordedFee = await step('row_reaches_delivering', BUDGET.rowDelivering, async () => {
          const row = await walletA.latestBridgeReceive('usdcx');
          if (!row) throw new Error('the deposit screen created no usdcx bridged-receive row');
          bridgeTxId = row.id;
          evidence.ids.depositRow = bridgeTxId;
          const state = await pollUntil(
            'the deposit row leaving submitting',
            rowState,
            read => read !== undefined && read.phase !== 'submitting',
            { timeoutMs: BUDGET.rowDelivering - 15_000, intervalMs: 3_000 }
          );
          // What runUsdcxExecutorDeposit wrote with the burn: the hash, the signed recipient and the forwarded leg.
          expect(
            {
              sourceChainId: state?.sourceChainId,
              evmTxHash: state?.evmTxHash?.toLowerCase(),
              usdcxRemoteRecipient: state?.usdcxRemoteRecipient,
              cctpForwarded: state?.cctpForwarded
            },
            `deposit row ${bridgeTxId}`
          ).toEqual({
            sourceChainId: chain.chainId,
            evmTxHash: burnHash.toLowerCase(),
            usdcxRemoteRecipient: recipient,
            cctpForwarded: true
          });
          const fee = state?.cctpForwardFee;
          if (fee === undefined || !/^\d+$/.test(fee))
            throw new Error(`deposit row ${bridgeTxId} records no forward fee`);
          return BigInt(fee);
        });

        const requests = await step('deposit_requests', BUDGET.check, async () =>
          executorDepositRequests(counterparty.requests, {
            l2,
            units: DEPOSIT_UNITS,
            recipient,
            depositor: evmAddress,
            recordedFee,
            allowanceBefore: funded.allowance
          })
        );
        evidence.hashes.approve = requests.approve?.hash ?? 'none';
        evidence.fees.push({ name: 'circle forward fee', amount: recordedFee, kind: 'exact' });

        const burn = await step('source_burn', BUDGET.sourceBurn, () =>
          confirmL2Burn(
            {
              endpoint: sender.endpoint,
              burnHash,
              signed: { hookData: requests.burn.hookData },
              burnQuote: { feeTotalAmount: recordedFee }
            },
            { l2, units: DEPOSIT_UNITS, depositor: evmAddress },
            reads
          )
        );
        evidence.ids.burnBlock = String(burn.blockNumber);

        const iris = await step('iris', BUDGET.iris, () =>
          waitForIrisForward({ l2, burnHash, sentMessage: burn.sentMessage }, { timeoutMs: BUDGET.iris - 15_000 })
        );
        evidence.hashes.forward = iris.forwardTxHash;
        evidence.ids.cctpNonce = iris.nonce;
        evidence.latenciesMs.submitToForwardSeen = iris.seenAtMs - submittedAt;

        const executed = await step('arc_forward', BUDGET.arcForward, () =>
          confirmArcForward(
            iris.forwardTxHash,
            {
              l2,
              nonce: iris.nonce,
              units: DEPOSIT_UNITS,
              remoteRecipient: recipient,
              remoteToken: xreserve.remoteToken
            },
            arc
          )
        );
        evidence.ids.forwardBlock = String(executed.blockNumber);

        await step('row_forward', BUDGET.rowForward, () =>
          pollUntil(
            "the wallet's row taking Circle's Arc forward as its execute",
            rowState,
            state => state?.usdcxExecuteTxHash?.toLowerCase() === iris.forwardTxHash.toLowerCase(),
            {
              timeoutMs: BUDGET.rowForward - 5_000,
              intervalMs: 3_000,
              describe: async last =>
                `row phase ${last?.phase ?? 'unread'}, execute ${last?.usdcxExecuteTxHash ?? 'none'}, ` +
                `error ${last?.error ?? 'none'}`
            }
          )
        );

        const attested = await step('attest', BUDGET.attest, async () => {
          const attestation = await waitForXReserveAttestation(iris.forwardTxHash, {
            baseUrl: ARC_ATTESTATION_API,
            timeoutMs: BUDGET.attest - 15_000,
            pollMs: 3_000
          });
          const attestedAt = Date.now();
          // An executor deposit's depositor is the DepositFor handler, never the key (attestation-protocol.ts).
          const { intent, signer } = await assertDepositIntent(attestation, {
            amount: DEPOSIT_UNITS,
            remoteToken: xreserve.remoteToken,
            remoteRecipient: recipient,
            localToken: ARC_USDC,
            localDepositor: l2.source.target.handler
          });
          const verdict = matchUsdcxDepositAttestation([attestation], {
            remoteRecipient: recipient,
            remoteToken: xreserve.remoteToken,
            amount: DEPOSIT_UNITS,
            remoteDomain: USDCX_REMOTE_DOMAIN
          });
          expect(verdict.kind, "the wallet's own matcher accepts Circle's attestation").toBe('attested');
          evidence.ids.attestationSigner = signer;
          evidence.hashes.attestationMessage = attestation.messageHash;
          return { intent, attestedAt };
        });

        const mintNoteId = await step('mint', BUDGET.mint, async () => {
          // Derived, not discovered: a mint to any other account or of any other amount cannot satisfy this read.
          const derived = await deriveUsdcxMintNoteId({
            faucetHex: ids.nativeHex,
            recipientHex: ids.accountHex,
            units: DEPOSIT_UNITS,
            nonce: attested.intent.nonce
          });
          const read = await waitForUsdcxMint(envConfig.rpcUrl, {
            mintNoteId: derived,
            depositHash: iris.forwardTxHash,
            nonce: attested.intent.nonce,
            faucetBech32: ids.nativeBare,
            accountBech32: ids.bare,
            // The account was created in this run, so every faucet note to it is recent.
            sinceBlock: 0,
            timeoutMs: BUDGET.mint - 15_000
          });
          expect(
            {
              committed: read.committed,
              sender: read.senderHex?.toLowerCase(),
              assets: read.assets.map(asset => ({ faucetHex: asset.faucetHex.toLowerCase(), amount: asset.amount }))
            },
            `mint note ${derived}`
          ).toEqual({
            committed: true,
            sender: ids.nativeHex.toLowerCase(),
            assets: [{ faucetHex: ids.nativeHex.toLowerCase(), amount: DEPOSIT_UNITS }]
          });
          return derived;
        });
        evidence.ids.mintNote = mintNoteId;
        evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;

        const depositVault = await step('receive', BUDGET.receive, async () => {
          // The wallet claims the mint by itself (USDCx is testnet's native asset) and moves the row to received only
          // once the consume it matched to the deposit has completed.
          await pollUntil(
            'the wallet claiming the mint and the row reading received',
            rowState,
            state => state?.phase === 'received',
            {
              timeoutMs: BUDGET.receive - VAULT_MS - 60_000,
              intervalMs: 5_000
            }
          );
          depositPhases.assertMonotone();
          evidence.phases.deposit = depositPhases.samples();
          const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
          const claim = exactlyOne(
            (await walletA.readTransactionRows({ type: 'consume' })).filter(row => row.status === TxStatus.Completed),
            'Completed consume on the fresh wallet, the claim of the minted note',
            describeTransactionRow
          );
          expect(
            {
              rowNote: state.midenNoteId?.toLowerCase(),
              rowAmount: state.amount,
              claimNotes: (claim.noteIds ?? []).map(id => id.toLowerCase()),
              displayMessage: claim.displayMessage,
              adoptedBy: jsonString(jsonObject(claim.extraInputs?.bridgeIn)?.bridgeReceiveTxId)
            },
            `deposit row ${bridgeTxId} and claim ${claim.id}`
          ).toEqual({
            rowNote: mintNoteId.toLowerCase(),
            rowAmount: DEPOSIT_UNITS.toString(),
            claimNotes: [mintNoteId.toLowerCase()],
            displayMessage: 'Bridged from EVM',
            adoptedBy: bridgeTxId
          });
          // A new wallet starts at zero, so the vault is the mint less the fee the claim's row recorded.
          const settled = await settleLedger(walletA, native, {
            name: 'f2',
            before: 0n,
            credit: DEPOSIT_UNITS,
            debits: 0n,
            row: claim
          });
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

        // The burn pays the key back on the source chain, so each green run refills the USDC its deposit spent there.
        const depositKey: PayoutKey = {
          key: { address: evmAddress, privateKey: keyHex },
          role: 'deposit',
          label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY) on ${chain.label}, which Circle pays,`
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
          payoutReads: reads,
          depositKey,
          evidence,
          secrets,
          screenshotDir: path.join(steps.outputDir, 'usdcx-burn')
        });
      } finally {
        await cp?.stop();
        // In the run's artifact directory, which the job uploads (test-results-ios/).
        const evidencePath = path.join(steps.outputDir, `usdcx-live-executor-${chain.reviewNetwork}-ios-evidence.json`);
        fs.mkdirSync(steps.outputDir, { recursive: true });
        fs.writeFileSync(evidencePath, evidenceBody(evidence, secrets));
        await test.info().attach(`usdcx-live-executor-${chain.reviewNetwork}-ios-evidence.json`, {
          path: evidencePath,
          contentType: 'application/json'
        });
      }
    });
  });
}
