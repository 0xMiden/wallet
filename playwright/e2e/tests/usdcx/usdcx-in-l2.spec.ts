import { formatUnits } from 'viem';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  readXReserveDomainState,
  waitForXReserveAttestation,
  type ArcReadDeps
} from '../../helpers/arc-usdcx';
import { vaultBalanceOfCurrentAccount } from '../../helpers/balance-truth';
import { bridgeReceiveState, createUsdcxBridgeReceive } from '../../helpers/bridge';
import { readTransactionRows } from '../../helpers/history';
import { confirmArcForward, confirmL2Burn, waitForIrisForward } from '../../helpers/usdcx-cctp-proof';
import {
  ARC_ATTESTATION_API,
  ARC_READ_STEP_BUDGET_MS,
  ARC_USDC,
  DEPOSIT_UNITS,
  L2_BRIDGE_IN_SOURCES,
  USDCX_REMOTE_DOMAIN
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  l2KeyShortfall,
  l2Reads,
  quoteL2Deposit,
  readL2KeyFunds,
  submitL2Deposit
} from '../../helpers/usdcx-l2-deposit';
import { attachEvidence, createGuardianUsdcxWallet, pageWhere, resolveUsdcxIds } from '../../helpers/usdcx-legs';
import { deriveUsdcxMintNoteId, waitForUsdcxMint } from '../../helpers/usdcx-miden';
import { receiveLeg, trackReceiveRows } from '../../helpers/usdcx-receive';
import {
  assertUsdcxLiveRun,
  depositClaimProblem,
  namedSteps,
  newRunEvidence,
  pollUntil,
  takeRunArcKey,
  type StepContext
} from '../../helpers/usdcx-run';

const BUDGET = {
  wallet: 180_000,
  // Each read step outlasts a stall on every endpoint before the last one answers, on Arc and on each L2.
  arcState: ARC_READ_STEP_BUDGET_MS,
  l2Key: ARC_READ_STEP_BUDGET_MS + 15_000,
  depositSubmit: 300_000,
  trackingRow: 10_000,
  sourceBurn: ARC_READ_STEP_BUDGET_MS,
  // A fast transfer forwarded in 8-10 s when probed; Circle falls back to source finality (15-20 min) when its fast
  // allowance runs out, and the wallet tells users about 20 min.
  iris: 1_500_000,
  arcForward: 150_000,
  rowForward: 60_000,
  attest: 120_000,
  mint: 180_000,
  receive: 360_000,
  check: 60_000
} as const;
/** The reconciler takes Circle's forward on one 8 s tick and finds its attestation on the next. */
const READY_WITHIN_MS = 30_000;

/**
 * A deposit the harness key signs on Base Sepolia, and one on Arbitrum Sepolia, through the wallet's own executor-route
 * deposit: Circle attests and forwards it to Arc, its executor deposits into xReserve for a fresh Guardian wallet, and
 * the relayer mints. Run only through `yarn e2e:real --suite usdcx-in-l2`. Each test ends once the wallet claimed the
 * mint and its row reads received.
 */
test.describe('USDCx L2 bridge-in from the harness key, forwarded by Circle to Arc', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  // ~2 min setup + 52.7 min of step budgets, 25 of them Circle's attestation at source finality, <= 55 min.
  test.describe.configure({ timeout: 3_300_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const l2 of L2_BRIDGE_IN_SOURCES) {
    const { payout: chain, source } = l2;
    test(`Guardian wallet receives a deposit from ${chain.networkName} that Circle forwards to Arc, then mints and claims it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads = l2Reads(l2);
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-in-l2 ${chain.reviewNetwork}`);
      const secrets: string[] = [];
      const cleanups: Array<() => Promise<void>> = [];
      let passed = false;
      try {
        const { identity, ids } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = await guardianIdentity(envConfig.guardianUrl);
            const address = await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl);
            const ids = await resolveUsdcxIds(walletA.page, address);
            // A base fee that outgrew the deposit would leave its mint unclaimed until the receive step timed out.
            const unclaimable = depositClaimProblem(DEPOSIT_UNITS, ids.baseFee);
            if (unclaimable !== undefined) throw new Error(unclaimable);
            expect(await vaultBalanceOfCurrentAccount(walletA.page, ids.native), 'a fresh account holds nothing').toBe(
              0n
            );
            const written = (await readTransactionRows(walletA.page)).filter(
              row => row.type === 'consume' || row.type === 'send' || row.type === 'bridged-send'
            );
            expect(written, 'nothing has deployed the account yet').toEqual([]);
            return { identity, ids };
          },
          async () => `guardian ${envConfig.guardianUrl}`
        );
        const onGuardian: StepContext = () => guardianFailureContext(identity);
        evidence.guardian = {
          url: identity.url,
          version: identity.version,
          gitCommit: identity.gitCommit,
          commitment: identity.commitment
        };
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;
        evidence.ids.sourceChainId = String(chain.chainId);

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

        // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
        const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);
        const funded = await step('l2_key', BUDGET.l2Key, async () => {
          const { key, role } = takeRunArcKey(process.env);
          expect(role, 'usdcx-in-l2 deposits from the harness key').toBe('harness');
          secrets.push(key.privateKey);
          const funds = await readL2KeyFunds(key.address, reads);
          const quote = await quoteL2Deposit(l2, { units: DEPOSIT_UNITS, recipient, depositor: key.address });
          const shortfall = l2KeyShortfall({
            label: chain.networkName,
            address: key.address,
            ...funds,
            units: DEPOSIT_UNITS,
            fee: quote.feeTotalAmount
          });
          if (shortfall !== undefined) throw new Error(shortfall);
          return { key, funds, fee: quote.feeTotalAmount };
        });
        evidence.ids.arcKey = funded.key.address;
        evidence.ids.arcKeyRole = 'harness';
        evidence.notes.push(
          `key on ${chain.networkName}: ${funded.funds.wei} wei, ${funded.funds.usdc} USDC base units, quoted fee ${funded.fee}`
        );

        // An overrun step runs on after the test failed; the signal stops it before it sends the approve or the burn.
        const submission = await step('deposit_submit', BUDGET.depositSubmit, signal =>
          submitL2Deposit(
            { privateKey: funded.key.privateKey, l2, units: DEPOSIT_UNITS, recipientHex: ids.accountHex, arc },
            {},
            signal
          )
        );
        const submittedAt = Date.now();
        evidence.hashes.approve = submission.approveHash ?? 'none';
        evidence.hashes.burn = submission.burnHash;
        evidence.fees.push({ name: 'circle forward fee', amount: submission.burnQuote.feeTotalAmount, kind: 'exact' });
        evidence.notes.push(
          `approve ${submission.approveHash ? 'sent' : 'not needed'}, ${submission.quotes.length} quote(s), ` +
            `writes via ${arcHost(submission.endpoint)}`
        );

        // The row the deposit screen would have made, with the product's own submitting write replayed on it.
        const rowId = await step('tracking_row', BUDGET.trackingRow, () =>
          createUsdcxBridgeReceive(walletA, {
            accountId: ids.address,
            amount: DEPOSIT_UNITS.toString(),
            faucetId: ids.native,
            sourceChainId: chain.chainId,
            sourceAddress: funded.key.address,
            sourceAmount: formatUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS),
            sourceSymbol: 'USDC',
            evmTxHash: submission.burnHash,
            usdcxRemoteRecipient: submission.submitted.usdcxRemoteRecipient,
            cctp: submission.submitted.cctp
          })
        );
        evidence.ids.positiveRow = rowId;
        const tracker = trackReceiveRows(walletA, rowId, undefined);
        cleanups.push(() => tracker.stop().catch(() => undefined));

        const burn = await step('source_burn', BUDGET.sourceBurn, () =>
          confirmL2Burn(submission, { l2, units: DEPOSIT_UNITS, depositor: funded.key.address }, reads)
        );
        evidence.ids.burnBlock = String(burn.blockNumber);

        const iris = await step('iris', BUDGET.iris, () =>
          waitForIrisForward(
            { l2, burnHash: submission.burnHash, sentMessage: burn.sentMessage },
            { timeoutMs: BUDGET.iris - 15_000 }
          )
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
            () => bridgeReceiveState(walletA, rowId),
            state => state.usdcxExecuteTxHash?.toLowerCase() === iris.forwardTxHash.toLowerCase(),
            {
              timeoutMs: BUDGET.rowForward - 5_000,
              intervalMs: 3_000,
              describe: async last =>
                `row phase ${last?.phase ?? 'unread'}, execute ${last?.usdcxExecuteTxHash ?? 'none'}, ` +
                `error ${last?.error ?? 'none'}; ${await where()}`
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
            localDepositor: source.target.handler
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
          const mintNoteId = await deriveUsdcxMintNoteId({
            faucetHex: ids.nativeHex,
            recipientHex: ids.accountHex,
            units: DEPOSIT_UNITS,
            nonce: attested.intent.nonce
          });
          const read = await waitForUsdcxMint(envConfig.rpcUrl, {
            mintNoteId,
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
            `mint note ${mintNoteId}`
          ).toEqual({
            committed: true,
            sender: ids.nativeHex.toLowerCase(),
            assets: [{ faucetHex: ids.nativeHex.toLowerCase(), amount: DEPOSIT_UNITS }]
          });
          return mintNoteId;
        });
        evidence.ids.mintNote = mintNoteId;
        evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;

        const received = await receiveLeg(
          step,
          walletA,
          ids,
          { positiveId: rowId, tracker, attestedAt: attested.attestedAt, mintNoteId },
          {
            vaultBefore: 0n,
            terms: [],
            where,
            onGuardian,
            evidence,
            budgetMs: BUDGET.receive,
            readyWithinMs: READY_WITHIN_MS
          }
        );
        evidence.fees.push(received.fee);
        evidence.ids.mintConsume = received.consumeId;

        await step(
          'receive_deploy',
          BUDGET.check,
          async () => {
            const transactions = (await readTransactionRows(walletA.page)).filter(
              row => row.type !== 'bridged-receive'
            );
            expect(
              transactions.map(row => row.id),
              'the mint consume is the first transaction and the deploy'
            ).toEqual([received.consumeId]);
            await walletA.assertGuardianAuth(ids.address, {
              signerCount: 2,
              threshold: 2,
              guardianCommitment: identity.commitment
            });
          },
          onGuardian
        );
        passed = true;
      } finally {
        for (const cleanup of cleanups) await cleanup();
        await attachEvidence(test.info(), 'usdcx-in-l2-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
