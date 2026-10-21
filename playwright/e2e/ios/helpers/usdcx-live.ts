/**
 * What the live iOS USDCx specs share: the vault read on Home, the hosted Guardian check, the evidence file, and the
 * burn half, which sends the deposit back with an optional public faucet grant.
 */
import { expect } from '@playwright/test';
import { formatUnits, isHex } from 'viem';

import type { IosNativeAsset, IosWalletPage } from './ios-wallet-page';
import { arcHost, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { optionalPublicFaucetGrant, publicFaucetApiUrl } from '../../helpers/public-faucet';
import { waitForPublicNoteCommitment } from '../../helpers/public-note-commitment';
import {
  ARC_PAYOUT,
  ARC_READ_STEP_BUDGET_MS,
  GRANT_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_DECIMALS,
  USDCX_REMOTE_DOMAIN,
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
import { roundtripBurnUnits } from '../../helpers/usdcx-roundtrip-funding';
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
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';

/** The store caught up within 5.1 s of a move Home (ios-spike-report.md section 4.1). */
export const VAULT_MS = 30_000;
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
export const BURN_BUDGET = {
  // the auth read, then 3 tries of /status and /pubkey at 15 s each: /pubkey answered one spike run with a 502 page
  guardianAccount: 150_000,
  // each Arc read step outlasts a stall on every endpoint before the last one answers (R24)
  arcState: ARC_READ_STEP_BUDGET_MS,
  // One optional request has a 30-second limit. A returned note must then commit.
  grant: 180_000,
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

export function noteIdsOf(row: TransactionRowSnapshot): string[] {
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
export async function settleLedger(
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
export function evidenceBody(evidence: RunEvidence, secrets: readonly string[]): string {
  const body = evidenceJson(evidence, secrets);
  if (/[?&]password=/.test(body)) {
    throw new Error('the evidence would carry the onboarding password, so it was not written');
  }
  return body;
}

/** The deposit landed on and was claimed by a Guardian account bound to the hosted Guardian the run identified. */
export function assertHostedGuardianAccount(
  step: NamedStep,
  wallet: IosWalletPage,
  opts: { address: string; guardianUrl: string; evidence: RunEvidence }
): Promise<GuardianIdentity> {
  return step('assert_guardian_account', BURN_BUDGET.guardianAccount, async () => {
    // The auth structure shows the deposit landed on, and was claimed by, a Guardian account, not a single-sig
    // one, so a spec cannot quietly go back to testing the single-sig path.
    const auth = await wallet.getGuardianAuthInfo(opts.address);
    expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
    expect(auth.signerCommitments.length, 'a fresh Guardian account has 2 signers (hot, cold)').toBe(2);
    expect(auth.procedureThresholds.update_guardian, 'update_guardian is hardened to threshold 2').toBe(2);
    const hosted = await hostedGuardian(opts.guardianUrl);
    opts.evidence.guardian = {
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
}

export interface BurnHalf {
  step: NamedStep;
  wallet: IosWalletPage;
  /** The wallet's account: the grant goes to it and the burn comes from it. */
  address: string;
  native: IosNativeAsset;
  envConfig: { name: string; rpcUrl: string };
  identity: GuardianIdentity;
  /** The vault before the grant, read on Home by the leg before. */
  vaultBefore: bigint;
  arc: ArcReadDeps;
  /** The payout chain's reads (`payoutChain` set); absent, Circle pays on Arc and `arc` reads it. */
  payoutReads?: ArcReadDeps;
  depositKey: PayoutKey;
  evidence: RunEvidence;
  secrets: string[];
  screenshotDir: string;
}

/**
 * The burn half of a live iOS run: an optional grant, then a burn through Send back to the deposit key on the
 * payout chain. It passes only once Circle paid the key exactly that burn within 10 minutes of the faucet's consume
 * (one AttestationUsed log carrying the burn note id, the key's whole rise above a read taken right before the burn)
 * and the wallet itself confirmed the payout: the row's destination balance, then the History pill.
 */
export async function burnBackToDepositKey(ctx: BurnHalf): Promise<void> {
  const { step, wallet, native, evidence } = ctx;
  const chain = ctx.payoutReads?.payoutChain ?? ARC_PAYOUT;
  const where: StepContext = async () =>
    describePage(await wallet.evalJs<string>('return location.href;'), () =>
      wallet.evalJs<string>('return document.visibilityState;')
    );
  const onGuardian: StepContext = () => guardianFailureContext(ctx.identity);
  const faucetUrl = publicFaucetApiUrl(ctx.envConfig.name);
  if (!faucetUrl) throw new Error(`no public faucet for ${ctx.envConfig.name}`);

  // Before the grant, so a bridge that cannot pay this burn out costs no grant and leaves no deferred payout.
  const xreserve = await step('arc_state', BURN_BUDGET.arcState, async () => {
    const state = await readXReserveDomainState(ctx.arc);
    expect(
      { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
      `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
    ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
    return state;
  });

  roundtripBurnUnits(ctx.vaultBefore, false);
  const grant = await step('grant', BURN_BUDGET.grant, async signal => {
    // R19: one grant from the 10 USDCx tier; asking for no amount gets the largest, 100 USDCx.
    const result = await optionalPublicFaucetGrant(faucetUrl, ctx.address, GRANT_UNITS, signal);
    if (result.kind === 'unavailable') {
      evidence.ids.faucetGrant = 'unavailable';
      evidence.notes.push(`Optional faucet grant failed: ${result.reason}`);
      console.warn(`Optional faucet grant failed; using the deposit: ${result.reason}`);
      return undefined;
    }
    evidence.ids.faucetGrant = 'granted';
    const { noteId } = result;
    if (!isHex(noteId)) throw new Error(`the public faucet answered note id ${noteId}`);
    await waitForPublicNoteCommitment(ctx.envConfig.rpcUrl, noteId, 120_000);
    const asset = exactlyOne(
      (await note(ctx.envConfig.rpcUrl, noteId)).assets,
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
  let grantedVault = ctx.vaultBefore;
  if (grant) {
    evidence.ids.grantNote = grant.noteId;

    grantedVault = await step(
      'grant_consumed',
      BURN_BUDGET.grantConsumed,
      async () => {
        const claim = await pollUntil(
          'the wallet auto-consuming the grant',
          async () =>
            (await wallet.readTransactionRows({ type: 'consume' })).find(row =>
              noteIdsOf(row).includes(grant.noteId.toLowerCase())
            ),
          row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
          { timeoutMs: BURN_BUDGET.grantConsumed - VAULT_MS - 30_000, intervalMs: 3_000, describe: () => where() }
        );
        if (claim?.status !== TxStatus.Completed) {
          throw new Error(`the grant's consume failed: ${claim ? describeTransactionRow(claim) : 'no row'}`);
        }
        const settled = await settleLedger(wallet, native, {
          name: 'f0',
          before: ctx.vaultBefore,
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
      BURN_BUDGET.settle,
      async () => {
        const started = Date.now();
        await pollUntil(
          'the grant consume committing',
          () => nullifier(ctx.envConfig.rpcUrl, grant.noteId),
          read => read.committed,
          { timeoutMs: BURN_BUDGET.settle - GUARDIAN_SETTLE_MS - 10_000, intervalMs: 3_000 }
        );
        await wallet.delay(GUARDIAN_SETTLE_MS);
        assertNoGuardianOpInFlight(await wallet.readTransactionRows(), ctx.address);
        return Date.now() - started;
      },
      onGuardian
    );
  } else {
    await step(
      'settle_deposit',
      BURN_BUDGET.settle,
      async () => {
        await wallet.delay(GUARDIAN_SETTLE_MS);
        assertNoGuardianOpInFlight(await wallet.readTransactionRows(), ctx.address);
      },
      onGuardian
    );
  }
  const burnUnits = roundtripBurnUnits(grantedVault, grant !== undefined);
  evidence.ids.burnUnits = burnUnits.toString();

  // The leg reads the key right before the burn, after the deposit's own transactions were mined, and its payout gate
  // counts only what this burn adds above that read (R21, R22); the label names the key Circle pays in every failure.
  const { key, snapshot, waitForPayout } = await payoutLeg(step, {
    takeKey: () => ctx.depositKey,
    arc: ctx.arc,
    payoutReads: ctx.payoutReads,
    budget: BURN_BUDGET,
    evidence,
    secrets: ctx.secrets
  });

  const submission = await step(
    'burn_via_send',
    BURN_BUDGET.burnViaSend,
    signal =>
      wallet.burnUsdcxViaSendFlow({
        destAddress: key.address,
        amount: formatUnits(burnUnits, USDCX_DECIMALS),
        nativeTokenId: native.tokenId,
        nativeSymbol: native.symbol,
        payout: chain,
        screenshotDir: ctx.screenshotDir,
        // R26: an overrun step never submits the burn after its test failed.
        signal
      }),
    onGuardian
  );
  evidence.ids.burnRow = submission.rowId;
  evidence.notes.push(
    `review ${submission.reviewRoute}`,
    `generating ${submission.generatingRoute}`,
    `network rows pressed before the ${chain.networkName} pick: ${submission.defaultPressed.join(', ') || 'none'}`
  );

  const burned = await step(
    'burn_completed',
    BURN_BUDGET.burnCompleted,
    async () => {
      const { row, stages } = await wallet.waitForBurnCompleted(submission.rowId, BURN_BUDGET.burnCompleted - 15_000);
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
        `burn row ${row.id}; the leg read ${snapshot.balance} on the key at ${chain.label} block ` +
          `${snapshot.blockNumber} right before the burn`
      ).toEqual({
        provider: 'usdcx',
        to: key.address.toLowerCase(),
        chain: chain.chainId,
        domain: chain.burnDomain,
        // The wallet's own snapshot of the key must be the one the payout gate counts from.
        before: snapshot.balance.toString()
      });
      evidence.notes.push(`burn stages ${JSON.stringify(stages)}`);
      return {
        row,
        burnNoteId,
        payoutFromBlock: BigInt(usdcxBurn?.destinationBalanceBefore?.blockNumber ?? '0')
      };
    },
    onGuardian
  );
  evidence.ids.burnNote = burned.burnNoteId;
  evidence.hashes.burnTransaction = burned.row.transactionId ?? 'none';

  const consumed = await step(
    'burn_consumed',
    BURN_BUDGET.burnConsumed,
    async () => {
      // The wallet's watcher moves the phase only while a wallet page is visible, so the run waits on Home.
      await wallet.navigateHome();
      const phases = new PhaseTimeline('burn row', BURN_PHASES);
      await pollUntil(
        'the faucet consuming the burn note',
        async () => {
          const rows = await wallet.readBridgedSendRows();
          const phase = rows.find(row => row.id === burned.row.id)?.extraInputs?.usdcxBurn?.phase;
          phases.record(phase, Date.now());
          if (phase === 'discarded') throw new Error(`the node discarded burn note ${burned.burnNoteId}`);
          return phase;
        },
        phase => phase === 'confirmed',
        { timeoutMs: BURN_BUDGET.burnConsumed - VAULT_MS - 60_000, intervalMs: 3_000, describe: () => where() }
      );
      phases.assertMonotone();
      evidence.phases.burn = phases.samples();
      const oracle = await burnEvidence(ctx.envConfig.rpcUrl, {
        faucetBech32: native.tokenId,
        noteId: burned.burnNoteId,
        senderBech32: ctx.address,
        domain: chain.burnDomain,
        recipient: key.address,
        amount: burnUnits
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
          ['N', burnUnits],
          ['s', oracle.sponsorshipUnits],
          ['f1', BigInt(burned.row.feeAmount ?? '-1')]
        ]);
        if (read !== want) throw new Error(`the burn's outputs by role read ${read}, expected ${want}`);
      }
      // Only the local completion path lists the burn note; a landed one rests on the oracle above (R24).
      const unlisted = burnOutputNoteProblem(completion, burned.row, burned.burnNoteId);
      if (unlisted !== undefined) throw new Error(unlisted);
      const settled = await settleLedger(wallet, native, {
        name: 'f1',
        before: grantedVault,
        credit: 0n,
        debits: burnUnits + oracle.sponsorshipUnits,
        row: burned.row
      });
      evidence.fees.push(settled.fee, { name: 's', amount: oracle.sponsorshipUnits, kind: 'exact' });
      evidence.notes.push(
        `burn ledger ${ledgerLine([
          ['V1', grantedVault],
          ['N', burnUnits],
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
  // D3 in delta mode, a hard gate (the leg's payout step): exactly one AttestationUsed log whose gatewayMint carries
  // the burn note id, by the consume plus 10 min, that adds exactly its value to the key's balance above the snapshot.
  const payout = await waitForPayout({ burnNoteId: burned.burnNoteId, oracle: consumed }, xreserve.depositor);

  // Q6, a hard gate: the wallet's own destination check confirms the payout Circle made.
  const confirmedAt = await step('wallet_confirms_payout', BURN_BUDGET.walletConfirmed, async () => {
    await wallet.navigateHome();
    const at = await waitForWalletPayoutConfirmation({
      readRows: () => wallet.readBridgedSendRows(),
      rowId: burned.row.id,
      arcFromBlock: burned.payoutFromBlock,
      payout,
      key,
      arc: ctx.payoutReads ?? ctx.arc,
      where,
      evidence
    });
    await wallet.openTransactionDetails(burned.row.id);
    const pills: string[] = [];
    await pollUntil(
      'the History pill reading Confirmed',
      async () => {
        const { pill } = await wallet.transactionDetailsView(burned.row.id, chain.explorer);
        if (pill !== null && pills[pills.length - 1] !== pill) pills.push(pill);
        return pill;
      },
      pill => pill === enText('confirmed'),
      { timeoutMs: 30_000, intervalMs: 1_000 }
    );
    evidence.notes.push(`history pill ${pills.join(' then ')}`);
    // The receiving-tx link is a best-effort RPC match (CLAUDE.md), so only a link to another transaction fails.
    const linkDeadline = Date.now() + RECEIVING_TX_LINK_MS;
    let links = (await wallet.transactionDetailsView(burned.row.id, chain.explorer)).txLinks;
    while (links.length === 0 && Date.now() < linkDeadline) {
      await wallet.delay(1_000);
      links = (await wallet.transactionDetailsView(burned.row.id, chain.explorer)).txLinks;
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
    await wallet.navigateHome();
    return at;
  });
  evidence.latenciesMs.payoutToWalletConfirmation = confirmedAt - (consumeTsMs + payout.latencyMs);
}
