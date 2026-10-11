import type { Hex } from 'viem';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  assertDepositIntent,
  confirmDepositToMiden,
  readArcUsdc,
  readXReserveDomainState,
  submitDepositToMiden,
  waitForXReserveAttestation,
  type ArcKey,
  type ArcWriteDeps,
  type DecodedDepositIntent,
  type DepositSubmission,
  type GatewayPayout,
  type XReserveDomainState
} from '../../helpers/arc-usdcx';
import { fromBaseUnits, vaultBalanceOfCurrentAccount } from '../../helpers/balance-truth';
import { bridgeReceiveState, createUsdcxBridgeReceive, enText, readBridgedSendRows } from '../../helpers/bridge';
import {
  describeTransactionRow,
  openHistoryDetails,
  readTransactionRow,
  readTransactionRows
} from '../../helpers/history';
import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_PUBLIC_URL,
  ARC_USDC,
  BURN_UNITS,
  DEPOSIT_UNITS,
  GAS_RESERVE_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_REMOTE_DOMAIN,
  WALLET_CONFIRM_TIMEOUT_MS
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity, type GuardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  consumeFeeAndVault,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  harnessPayoutLeg,
  historyPill,
  pageWhere,
  receivingTxHash,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn,
  waitForConsumeOf,
  type BurnLeg,
  type UsdcxWalletIds
} from '../../helpers/usdcx-legs';
import { deriveUsdcxMintNoteId, waitForUsdcxMint, type MidenNoteRead } from '../../helpers/usdcx-miden';
import {
  assertUsdcxLiveRun,
  depositClaimProblem,
  errorText,
  jsonObject,
  jsonString,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  sampleInBackground,
  takeRunArcKey,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';

/**
 * Live USDCx on testnet with a fresh Guardian wallet on the hosted Guardian (playwright/e2e/docs/e2e-architecture.md,
 * section 8). Run only through `yarn e2e:real --suite usdcx` or `--suite usdcx-in`: both describes throw, never skip,
 * without the runner's environment.
 */

/** Step budgets of spec sections 5 and 6, each a small multiple of the spike's step time. */
const BUDGET = {
  guardianWallet: 180_000,
  arcState: 30_000,
  fund: 180_000,
  settle: 240_000,
  keySnapshot: 30_000,
  fundedKey: 10_000,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000,
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  walletPayoutConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000,
  depositSubmit: 120_000,
  trackingRows: 10_000,
  depositConfirm: 120_000,
  attest: 120_000,
  mint: 180_000,
  receive: 360_000,
  check: 10_000
} as const;

const SETTLE_WAIT_MS = 120_000;
const RECEIVING_TX_LINK_MS = 15_000;

/**
 * A real Arc deposit Circle attested, with this token and amount, to Miden account 0x8da911727d5b53916f2c221c00c091.
 * Claimed for this run's account, it must end `failed`, never `ready`.
 */
const FOREIGN_DEPOSIT = {
  amount: '2000000000',
  sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99',
  sourceAmount: '2000',
  evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'
} as const;
const FOREIGN_RECIPIENT_ERROR = 'Circle attested this deposit to a different Miden account.';

interface ReceiveTracker {
  positive: PhaseTimeline;
  negative: { id: string; timeline: PhaseTimeline; error(): string | undefined } | null;
  stop(): Promise<void>;
}

interface DepositRun {
  submission: DepositSubmission;
  positiveId: string;
  tracker: ReceiveTracker;
  intent: DecodedDepositIntent;
  attestedAt: number;
  mintNoteId: Hex;
  mint: MidenNoteRead;
}

interface DepositOptions {
  key: ArcKey;
  /** USDC base units the key holds, which must cover the deposit and its gas. */
  keyBalance: bigint;
  approve: 'exact' | 'if-short';
  arc: ArcWriteDeps;
  xreserve: XReserveDomainState;
  rpcUrl: string;
  withNegative: boolean;
  /** Miden block from which the faucet's notes to this account count as recent, for the mint failure's listing. */
  sinceBlock: number;
  /** The tag the grant note carried to this account; the mint note must route the same way. */
  accountTag?: number;
  evidence: RunEvidence;
  cleanups: Array<() => Promise<void>>;
}

interface ReceiveOptions {
  vaultBefore: bigint;
  terms: ReadonlyArray<readonly [string, bigint]>;
  where: StepContext;
  onGuardian: StepContext;
  evidence: RunEvidence;
}

/** Spec 5 step 1: a fresh Guardian wallet on the hosted Guardian, with that Guardian's identity recorded. */
async function guardianWallet(
  wallet: GuardianAwareWalletPage,
  guardianUrl: string,
  evidence: RunEvidence
): Promise<{ identity: GuardianIdentity; ids: UsdcxWalletIds }> {
  const identity = await guardianIdentity(guardianUrl);
  evidence.guardian = {
    url: identity.url,
    version: identity.version,
    gitCommit: identity.gitCommit,
    commitment: identity.commitment
  };
  const address = await createGuardianUsdcxWallet(wallet, guardianUrl);
  const ids = await resolveUsdcxIds(wallet.page, address);
  // R20: a base fee that has outgrown the deposit would leave its mint unclaimed until the receive step timed out.
  const unclaimable = depositClaimProblem(DEPOSIT_UNITS, ids.baseFee);
  if (unclaimable !== undefined) throw new Error(unclaimable);
  evidence.ids.address = ids.address;
  evidence.ids.native = ids.native;
  return { identity, ids };
}

/**
 * Samples both tracking rows every 2 s from the moment they exist. The mint lands ~30 s after the attestation and the
 * receive step starts only then, so a POSITIVE row can pass through `ready` long before anything else looks at it.
 */
function trackReceiveRows(
  wallet: GuardianAwareWalletPage,
  positiveId: string,
  negativeId: string | undefined
): ReceiveTracker {
  const positive = new PhaseTimeline('POSITIVE bridged-receive', ['delivering', 'ready', 'received']);
  const negative = new PhaseTimeline('NEGATIVE bridged-receive', ['delivering', 'failed']);
  const negativeState: { error?: string } = {};
  const sampler = sampleInBackground(async () => {
    const at = Date.now();
    positive.record((await bridgeReceiveState(wallet, positiveId)).phase, at);
    const foreign = negativeId === undefined ? undefined : await bridgeReceiveState(wallet, negativeId);
    negative.record(foreign?.phase, at);
    negativeState.error = foreign?.error ?? negativeState.error;
    return positive.last() === 'received' && (negativeId === undefined || negative.last() === 'failed');
  }, 2_000);
  return {
    positive,
    negative:
      negativeId === undefined ? null : { id: negativeId, timeline: negative, error: () => negativeState.error },
    stop: () => sampler.stop()
  };
}

/** Spec 5 steps 9 to 13: a Node-signed deposit from `key`, its tracking rows, Circle's attestation and the mint. */
async function depositLeg(
  step: NamedStep,
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: DepositOptions
): Promise<DepositRun> {
  // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
  const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);
  const submission = await step('deposit_submit', BUDGET.depositSubmit, async () => {
    if (opts.keyBalance < DEPOSIT_UNITS + GAS_RESERVE_UNITS) {
      throw new Error(
        `key ${opts.key.address} holds ${opts.keyBalance} USDC base units, ` +
          `needs ${DEPOSIT_UNITS + GAS_RESERVE_UNITS} for the deposit and its gas`
      );
    }
    const submission = await submitDepositToMiden(
      { privateKey: opts.key.privateKey, units: DEPOSIT_UNITS, recipientHex: ids.accountHex, approve: opts.approve },
      opts.arc
    );
    // 'exact' approves the deposit amount even over an allowance an earlier run left on the harness key, so the round
    // trip always sends the approve the product sends (the allowance check in runUsdcxDeposit, usdcx/deposit.ts).
    if (opts.approve === 'exact' && (!submission.approved || !submission.approveHash)) {
      throw new Error(`the deposit ${submission.depositHash} sent no approve`);
    }
    return submission;
  });
  opts.evidence.hashes.deposit = submission.depositHash;
  opts.evidence.hashes.approve = submission.approveHash ?? 'none';
  opts.evidence.notes.push(
    `deposit approve (${opts.approve}) ${submission.approved ? 'sent' : 'not needed'} via ${submission.endpoint}`
  );

  // The hook persists no recipient, so both rows exercise the reconciler's derive-from-row path. `provider` and
  // `sourceChainId` keep them off the Epoch branch and the legacy Sepolia default (the provider switch and
  // reconcileUsdcxRow in bridge-receive.ts).
  const rows = await step('tracking_rows', BUDGET.trackingRows, async () => {
    const shared = { accountId: ids.address, faucetId: ids.native, sourceChainId: ARC_CHAIN_ID, sourceSymbol: 'USDC' };
    const positiveId = await createUsdcxBridgeReceive(wallet, {
      ...shared,
      amount: DEPOSIT_UNITS.toString(),
      sourceAddress: opts.key.address,
      sourceAmount: fromBaseUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS),
      evmTxHash: submission.depositHash
    });
    // A real attested deposit to another account: the reconciler must fail it on the recipient, never mark it ready.
    const negativeId = opts.withNegative
      ? await createUsdcxBridgeReceive(wallet, { ...shared, ...FOREIGN_DEPOSIT })
      : undefined;
    return { positiveId, negativeId };
  });
  opts.evidence.ids.positiveRow = rows.positiveId;
  opts.evidence.ids.negativeRow = rows.negativeId ?? 'none';
  const tracker = trackReceiveRows(wallet, rows.positiveId, rows.negativeId);
  opts.cleanups.push(() => tracker.stop().catch(() => undefined));

  // maxFee 0 and empty hookData are what the product signs (USDCX_DEPOSIT_MAX_FEE and USDCX_DEPOSIT_HOOK_DATA in
  // usdcx/constant.ts).
  await step('deposit_confirm', BUDGET.depositConfirm, async () => {
    const { event } = await confirmDepositToMiden(submission, opts.arc);
    expect(
      {
        value: event.value,
        localDepositor: event.localDepositor.toLowerCase(),
        remoteRecipient: event.remoteRecipient.toLowerCase(),
        remoteDomain: event.remoteDomain,
        remoteToken: event.remoteToken.toLowerCase(),
        maxFee: event.maxFee,
        hookData: event.hookData
      },
      `DepositedToRemote of ${submission.depositHash}`
    ).toEqual({
      value: DEPOSIT_UNITS,
      localDepositor: opts.key.address.toLowerCase(),
      remoteRecipient: recipient.toLowerCase(),
      remoteDomain: USDCX_REMOTE_DOMAIN,
      remoteToken: opts.xreserve.remoteToken.toLowerCase(),
      maxFee: 0n,
      hookData: '0x'
    });
  });

  const attested = await step('attest', BUDGET.attest, async () => {
    const attestation = await waitForXReserveAttestation(submission.depositHash, {
      baseUrl: ARC_ATTESTATION_API,
      timeoutMs: BUDGET.attest - 15_000,
      pollMs: 3_000
    });
    // When the harness first saw the attestation; the wallet's reconciler polls every 8 s while its page is visible.
    const attestedAt = Date.now();
    const { intent, signer } = await assertDepositIntent(attestation, {
      amount: DEPOSIT_UNITS,
      remoteToken: opts.xreserve.remoteToken,
      remoteRecipient: recipient,
      localToken: ARC_USDC,
      localDepositor: opts.key.address
    });
    const verdict = matchUsdcxDepositAttestation([attestation], {
      remoteRecipient: recipient,
      remoteToken: opts.xreserve.remoteToken,
      amount: DEPOSIT_UNITS
    });
    expect(verdict.kind, "the wallet's own matcher accepts Circle's attestation").toBe('attested');
    opts.evidence.ids.attestationSigner = signer;
    opts.evidence.hashes.attestationMessage = attestation.messageHash;
    return { intent, attestedAt };
  });

  const mint = await step('mint', BUDGET.mint, async () => {
    // Derived, not discovered: a mint to any other account or of any other amount cannot satisfy this read.
    const mintNoteId = await deriveUsdcxMintNoteId({
      faucetHex: ids.nativeHex,
      recipientHex: ids.accountHex,
      units: DEPOSIT_UNITS,
      nonce: attested.intent.nonce
    });
    const read = await waitForUsdcxMint(opts.rpcUrl, {
      mintNoteId,
      depositHash: submission.depositHash,
      nonce: attested.intent.nonce,
      faucetBech32: ids.nativeBare,
      accountBech32: ids.bare,
      sinceBlock: opts.sinceBlock,
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
    if (opts.accountTag !== undefined && read.tag !== opts.accountTag) {
      throw new Error(
        `mint note ${mintNoteId} carries tag ${read.tag}; the grant note to this account carried ${opts.accountTag}`
      );
    }
    return { mintNoteId, read };
  });
  opts.evidence.ids.mintNote = mint.mintNoteId;
  opts.evidence.notes.push(`mint note tag ${mint.read.tag ?? 'unread'}`);
  opts.evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;
  return {
    submission,
    positiveId: rows.positiveId,
    tracker,
    intent: attested.intent,
    attestedAt: attested.attestedAt,
    mintNoteId: mint.mintNoteId,
    mint: mint.read
  };
}

/** Spec 5 step 14: the service worker consumes the mint by itself, and the POSITIVE row ends `received` on that consume. */
async function receiveLeg(
  step: NamedStep,
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  deposit: DepositRun,
  opts: ReceiveOptions
): Promise<{ consumeId: string; fee: FeeTerm; vault: bigint }> {
  return step(
    'receive',
    BUDGET.receive,
    async () => {
      const page = wallet.page;
      // A row sampled at `ready` must read Confirmed, or Completed once a re-read shows it already `received`.
      const readyPill = deposit.tracker.positive.saw('ready') ? await historyPill(wallet, deposit.positiveId) : null;
      const phaseAfterPill = readyPill === null ? null : (await bridgeReceiveState(wallet, deposit.positiveId)).phase;
      if (
        readyPill !== null &&
        readyPill !== enText('confirmed') &&
        !(readyPill === enText('completed') && phaseAfterPill === 'received')
      ) {
        throw new Error(
          `the ready POSITIVE row's details read "${readyPill}" (phase now ${phaseAfterPill ?? 'unread'})`
        );
      }
      opts.evidence.notes.push(
        readyPill === null ? 'POSITIVE was not sampled at ready' : `ready POSITIVE details read "${readyPill}"`
      );
      await wallet.navigateHome();

      // The service worker consumes the mint by itself; a claim call would add a second consume row.
      const consume = await waitForConsumeOf(page, deposit.mintNoteId, 'mint', BUDGET.receive - 120_000, opts.where);
      expect(
        (consume.noteIds ?? []).map(id => id.toLowerCase()),
        'the mint consume carries nothing but the mint note'
      ).toEqual([deposit.mintNoteId.toLowerCase()]);
      // The adoption writes the consume's `bridgeIn` and the POSITIVE's `received` right after the consume completes.
      const adopted = await pollUntil(
        'the mint consume adopting the POSITIVE row',
        async () => ({
          consume: await readTransactionRow(page, consume.id),
          positive: await bridgeReceiveState(wallet, deposit.positiveId)
        }),
        ({ consume: row, positive }) =>
          jsonObject(row?.extraInputs?.bridgeIn) !== undefined && positive.phase === 'received',
        {
          timeoutMs: 60_000,
          intervalMs: 3_000,
          describe: async last =>
            `consume ${last?.consume ? describeTransactionRow(last.consume) : 'missing'}, ` +
            `POSITIVE ${last?.positive.phase ?? 'unread'}; ${await opts.where()}`
        }
      );
      const consumeRow = adopted.consume;
      if (!consumeRow) throw new Error(`consume ${consume.id} disappeared`);
      expect({
        displayMessage: consumeRow.displayMessage,
        bridgeReceiveTxId: jsonString(jsonObject(consumeRow.extraInputs?.bridgeIn)?.bridgeReceiveTxId)
      }).toEqual({ displayMessage: 'Bridged from EVM', bridgeReceiveTxId: deposit.positiveId });

      const { fee, vault } = await consumeFeeAndVault(page, ids, consumeRow, {
        fee: 'f2',
        vaultBefore: opts.vaultBefore,
        credit: DEPOSIT_UNITS,
        terms: [...opts.terms, ['M', DEPOSIT_UNITS]]
      });
      opts.evidence.notes.push(
        `mint consume ${consumeRow.id} completed ${fee.kind === 'exact' ? 'with its result' : 'through a landed path'}`
      );

      const positiveRow = await readTransactionRow(page, deposit.positiveId);
      expect({
        phase: adopted.positive.phase,
        midenNoteId: adopted.positive.midenNoteId?.toLowerCase(),
        amount: adopted.positive.amount,
        error: adopted.positive.error,
        transactionId: positiveRow?.transactionId
      }).toEqual({
        phase: 'received',
        midenNoteId: deposit.mintNoteId.toLowerCase(),
        amount: DEPOSIT_UNITS.toString(),
        error: undefined,
        transactionId: consumeRow.transactionId
      });

      await deposit.tracker.stop();
      const positive = deposit.tracker.positive;
      positive.assertMonotone();
      opts.evidence.phases.positive = positive.samples();
      opts.evidence.notes.push(`POSITIVE ready ${positive.saw('ready') ? 'was' : 'was not'} sampled`);
      // The watcher reconciles within one 8 s tick of the attestation, give or take Circle's API; 20 s allows two.
      const settledAt = Math.min(positive.firstAt('ready') ?? Infinity, positive.firstAt('received') ?? Infinity);
      expect(
        settledAt,
        `POSITIVE stayed delivering 20 s after the attestation: ${positive.describe()}`
      ).toBeLessThanOrEqual(deposit.attestedAt + 20_000);

      await openHistoryDetails(wallet, deposit.positiveId);
      await expect(page.getByTestId('history-status-pill')).toHaveText(enText('completed'));
      await wallet.navigateHome();
      return { consumeId: consumeRow.id, fee, vault };
    },
    opts.onGuardian
  );
}

/** Spec 5 step 14: the NEGATIVE row fails on the recipient within 30 s of the attestation and is never `ready`. */
function assertNegativeFailed(deposit: DepositRun, evidence: RunEvidence): void {
  const negative = deposit.tracker.negative;
  if (!negative) throw new Error('the run tracked no NEGATIVE row');
  evidence.phases.negative = negative.timeline.samples();
  negative.timeline.assertMonotone();
  expect({ last: negative.timeline.last(), error: negative.error() }).toEqual({
    last: 'failed',
    error: FOREIGN_RECIPIENT_ERROR
  });
  expect(
    negative.timeline.firstAt('failed') ?? Infinity,
    `NEGATIVE failed more than 30 s after the attestation: ${negative.timeline.describe()}`
  ).toBeLessThanOrEqual(deposit.attestedAt + 30_000);
}

/** Spec 5 step 8b (Q6, a hard gate): the wallet's own destination check confirms the payout Circle made. */
async function walletConfirmsPayout(
  wallet: GuardianAwareWalletPage,
  burn: BurnLeg,
  payout: GatewayPayout,
  key: ArcKey,
  arc: ArcWriteDeps,
  where: StepContext,
  evidence: RunEvidence
): Promise<number> {
  await wallet.navigateHome();
  const row = await pollUntil(
    'the wallet confirming the payout',
    async () => (await readBridgedSendRows(wallet.page)).find(candidate => candidate.id === burn.row.id),
    found => found?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed !== undefined,
    {
      timeoutMs: WALLET_CONFIRM_TIMEOUT_MS,
      intervalMs: 3_000,
      describe: async last => {
        const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
        const arcIo = await readArcUsdc(key.address, { endpoints: [ARC_PUBLIC_URL] }).then(
          balance => `arc.io reads ${balance}`,
          (error: unknown) => `arc.io failed: ${errorText(error)}`
        );
        const before = JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore);
        return (
          `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
          `${before}, key balance now ${keyNow}, ${arcIo}; ${await where()}`
        );
      }
    }
  );
  const confirmedAt = Date.now();
  const confirmed = row?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed;
  const confirmedBlock = BigInt(confirmed?.blockNumber ?? '0');
  expect(
    {
      balance: confirmed?.balance,
      afterSnapshot: confirmedBlock > burn.arcFromBlock,
      atOrAfterPayout: confirmedBlock >= payout.logBlock
    },
    `confirmation at Arc block ${confirmedBlock}, snapshot ${burn.arcFromBlock}, payout log ${payout.logBlock}, ` +
      `${payout.balance - payout.value} on the key before the burn`
  ).toEqual({ balance: payout.balance.toString(), afterSnapshot: true, atOrAfterPayout: true });
  evidence.ids.walletConfirmedBalance = String(confirmed?.balance);
  await openHistoryDetails(wallet, burn.row.id);
  await expect(wallet.page.getByTestId('history-status-pill')).toHaveText(enText('confirmed'));
  const linkHash = await receivingTxHash(wallet.page, RECEIVING_TX_LINK_MS);
  if (linkHash !== null && linkHash !== payout.transactionHash.toLowerCase()) {
    throw new Error(
      `the receiving-tx link names ${linkHash}; the AttestationUsed transaction is ${payout.transactionHash}`
    );
  }
  evidence.notes.push(
    linkHash === null
      ? 'receiving-tx link did not render within 15 s'
      : 'receiving-tx link is the AttestationUsed transaction'
  );
  await wallet.navigateHome();
  return confirmedAt;
}

test.describe('USDCx round trip: burn to the harness Arc key, Circle payout, deposit back', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  test('Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt', async ({
    walletA,
    envConfig,
    steps
  }) => {
    const step = namedSteps(steps);
    const arc: ArcWriteDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const where = pageWhere(walletA);
    const evidence = newRunEvidence('usdcx');
    const secrets: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    let passed = false;
    try {
      const { identity, ids } = await step(
        'guardian_wallet',
        BUDGET.guardianWallet,
        () => guardianWallet(walletA, envConfig.guardianUrl, evidence),
        async () => `guardian ${envConfig.guardianUrl}`
      );
      const onGuardian: StepContext = () => guardianFailureContext(identity);

      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          {
            registered: state.registered,
            paused: state.paused,
            depositsPaused: state.depositsPaused,
            withdrawalsPaused: state.withdrawalsPaused
          },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${state.endpoint}`
        ).toEqual({ registered: true, paused: false, depositsPaused: false, withdrawalsPaused: false });
        return state;
      });

      const funding = await step(
        'fund',
        BUDGET.fund,
        async () => {
          expect(xreserve.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
            midenAccountHexToXReserveRecipient(ids.nativeHex)
          );
          const funding = await fundFromPublicFaucet(walletA.page, ids, envConfig.rpcUrl, where);
          await walletA.assertGuardianAuth(ids.address, {
            signerCount: 2,
            threshold: 2,
            guardianCommitment: identity.commitment
          });
          return funding;
        },
        onGuardian
      );
      evidence.fees.push(funding.f0);
      evidence.ids.grantNote = funding.grantNoteId;
      evidence.ids.grantConsume = funding.consumeId;

      evidence.settleMs.grant = await step(
        'settle_grant',
        BUDGET.settle,
        () => settleGuardian(walletA, SETTLE_WAIT_MS),
        onGuardian
      );

      // R21: the harness key, read right before the burn; the payout gate proves the rise above this read.
      const { key, snapshot, waitForPayout } = await harnessPayoutLeg(step, {
        env: process.env,
        arc,
        budget: BUDGET,
        evidence,
        secrets
      });

      const priorBurns = await step(
        'burn_via_ui',
        BUDGET.burnViaUi,
        () =>
          submitBurn(walletA, ids, {
            destination: key.address,
            units: BURN_UNITS,
            screenshotDir: test.info().outputDir
          }),
        onGuardian
      );
      const burn = await step(
        'burn_confirmed',
        BUDGET.burnConfirmed,
        async () => {
          const burn = await confirmBurn(walletA, ids, {
            priorRowIds: priorBurns,
            destination: key.address,
            keySnapshot: snapshot,
            units: BURN_UNITS,
            vaultBefore: funding.vault,
            rpcUrl: envConfig.rpcUrl,
            guardian: true,
            timeoutMs: BUDGET.burnRowPoll,
            where
          });
          await assertBurnDetails(walletA, burn.row.id, key.address);
          await walletA.navigateHome();
          return burn;
        },
        onGuardian
      );
      evidence.ids.burnRow = burn.row.id;
      evidence.ids.burnNote = burn.burnNoteId;
      evidence.hashes.burnTransaction = burn.row.transactionId ?? 'none';
      evidence.fees.push(burn.fee, { name: 's', amount: burn.sponsorship, kind: 'exact' });
      evidence.phases.burn = burn.phases.samples();

      // A discarded Guardian candidate fails here with the Guardian's message, not later as a 409 on the consume.
      evidence.settleMs.burn = await step(
        'settle_burn',
        BUDGET.settle,
        () => settleGuardian(walletA, SETTLE_WAIT_MS),
        onGuardian
      );

      const payout = await waitForPayout(burn, xreserve.depositor);

      // Before the deposit, which spends from the key: the wallet's confirmed balance must be exactly the pre-burn
      // read plus the payout.
      const walletConfirmedAt = await step('wallet_payout_confirmed', BUDGET.walletPayoutConfirmed, () =>
        walletConfirmsPayout(walletA, burn, payout, key, arc, where, evidence)
      );
      const paidAt = burn.oracle.consumeTimestampSec * 1_000 + payout.latencyMs;
      evidence.latenciesMs.payoutToWalletConfirmation = walletConfirmedAt - paidAt;

      const deposit = await depositLeg(step, walletA, ids, {
        key,
        keyBalance: payout.balance,
        approve: 'exact',
        arc,
        xreserve,
        rpcUrl: envConfig.rpcUrl,
        withNegative: true,
        sinceBlock: burn.oracle.consumeBlock,
        accountTag: funding.grantTag,
        evidence,
        cleanups
      });
      const terms: Array<readonly [string, bigint]> = [
        ['G', funding.grant],
        ['f0', funding.f0.amount],
        ['N', BURN_UNITS],
        ['f1', burn.fee.amount],
        ['s', burn.sponsorship]
      ];
      const received = await receiveLeg(step, walletA, ids, deposit, {
        vaultBefore: burn.vault,
        terms,
        where,
        onGuardian,
        evidence
      });
      evidence.fees.push(received.fee);
      evidence.ids.mintConsume = received.consumeId;

      await step('receive_negative', BUDGET.check, async () => assertNegativeFailed(deposit, evidence));
      await step('ledger', BUDGET.check, async () => {
        const whole: Array<readonly [string, bigint]> = [...terms, ['M', DEPOSIT_UNITS], ['f2', received.fee.amount]];
        expect(received.vault, `whole ledger ${ledgerLine(whole)}`).toBe(
          funding.grant -
            funding.f0.amount -
            BURN_UNITS -
            burn.fee.amount -
            burn.sponsorship +
            DEPOSIT_UNITS -
            received.fee.amount
        );
      });
      passed = true;
    } finally {
      for (const cleanup of cleanups) await cleanup();
      await attachEvidence(test.info(), 'usdcx-round-trip-evidence.json', evidence, secrets).catch((error: unknown) => {
        if (passed) throw error;
      });
    }
  });
});

test.describe('USDCx bridge-in from a funded Arc key', () => {
  test.use({ injectFeeFaucet: false });
  // Budgets add up to ~21 min, plus ~2 min of fixture setup charged to the test.
  test.describe.configure({ timeout: 1_800_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  test('Guardian wallet receives a Node-signed xReserve deposit', async ({ walletA, envConfig, steps }) => {
    const step = namedSteps(steps);
    const arc: ArcWriteDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const where = pageWhere(walletA);
    const evidence = newRunEvidence('usdcx-in');
    const secrets: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    let passed = false;
    try {
      const { identity, ids } = await step(
        'guardian_wallet',
        BUDGET.guardianWallet,
        async () => {
          const created = await guardianWallet(walletA, envConfig.guardianUrl, evidence);
          expect(
            await vaultBalanceOfCurrentAccount(walletA.page, created.ids.native),
            'a fresh account holds nothing'
          ).toBe(0n);
          // Nothing may have claimed or sent yet: the mint consume must be the account's first transaction and deploy.
          const written = (await readTransactionRows(walletA.page)).filter(
            row => row.type === 'consume' || row.type === 'send' || row.type === 'bridged-send'
          );
          expect(written, 'nothing has deployed the account yet').toEqual([]);
          return created;
        },
        async () => `guardian ${envConfig.guardianUrl}`
      );
      const onGuardian: StepContext = () => guardianFailureContext(identity);

      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${state.endpoint}`
        ).toEqual({ registered: true, paused: false, depositsPaused: false });
        expect(state.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
          midenAccountHexToXReserveRecipient(ids.nativeHex)
        );
        return state;
      });

      const funded = await step('funded_key', BUDGET.fundedKey, async () => {
        const { key, role } = takeRunArcKey(process.env);
        secrets.push(key.privateKey);
        const balance = await readArcUsdc(key.address, arc);
        if (balance < DEPOSIT_UNITS + GAS_RESERVE_UNITS) {
          throw new Error(
            `the ${role} key ${key.address} holds ${balance} USDC base units, needs ` +
              `${DEPOSIT_UNITS + GAS_RESERVE_UNITS}; ` +
              (role === 'harness'
                ? "refill it with yarn e2e:real --suite usdcx (each run's payout adds about 0.98 USDC), or pass " +
                  '--arc-key with a funded key'
                : 'fund it, or drop --arc-key and E2E_ARC_PRIVATE_KEY to deposit from the harness key')
          );
        }
        return { key, role, balance };
      });
      evidence.ids.arcKey = funded.key.address;
      evidence.ids.arcKeyRole = funded.role;

      const deposit = await depositLeg(step, walletA, ids, {
        key: funded.key,
        keyBalance: funded.balance,
        approve: 'if-short',
        arc,
        xreserve,
        rpcUrl: envConfig.rpcUrl,
        withNegative: false,
        // The account was created in this run, so every faucet note to its tag is recent.
        sinceBlock: 0,
        evidence,
        cleanups
      });
      const received = await receiveLeg(step, walletA, ids, deposit, {
        vaultBefore: 0n,
        terms: [],
        where,
        onGuardian,
        evidence
      });
      evidence.fees.push(received.fee);
      evidence.ids.mintConsume = received.consumeId;

      await step(
        'receive_deploy',
        BUDGET.check + 50_000,
        async () => {
          const transactions = (await readTransactionRows(walletA.page)).filter(row => row.type !== 'bridged-receive');
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
      await attachEvidence(test.info(), 'usdcx-in-evidence.json', evidence, secrets).catch((error: unknown) => {
        if (passed) throw error;
      });
    }
  });
});
