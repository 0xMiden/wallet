import { expect, type Page, type TestInfo } from '@playwright/test';
import { isHash, type Address, type Hash, type Hex } from 'viem';

import {
  arcHost,
  readArcUsdc,
  readArcUsdcSnapshot,
  readXReserveDomainState,
  realArcClock,
  waitForGatewayPayout,
  type ArcKey,
  type ArcReadDeps,
  type ArcUsdcSnapshot,
  type GatewayPayout
} from './arc-usdcx';
import {
  fromBaseUnits,
  vaultBalanceOfCurrentAccount,
  waitForVaultBalanceOfCurrentAccount,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from './balance-truth';
import { bridgeOutUsdcx, enText, readBridgedSendRows, readNativeDisplaySymbol, type BridgedSendRow } from './bridge';
import {
  describeTransactionRow,
  openHistoryDetails,
  readTransactionRows,
  TxStatus,
  type TransactionRowSnapshot
} from './history';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import {
  ARC_PAYOUT,
  BURN_UNITS,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  redactProjectId,
  USDCX_BURN_TAG,
  WALLET_CONFIRM_TIMEOUT_MS,
  type PayoutChain
} from './usdcx-constants';
import { assertNoGuardianOpInFlight, burnFailureMessage } from './usdcx-guardian';
import {
  accountHex,
  bareId,
  boundLandedFee,
  burnEvidence,
  burnOutputs,
  note,
  nullifier,
  type BurnEvidence
} from './usdcx-miden';
import {
  anyOf,
  boundedTerm,
  burnCompletionPath,
  burnOutputNoteProblem,
  consumeFeePath,
  describePage,
  errorText,
  evidenceJson,
  exactlyOne,
  explainSettleFailure,
  ledgerLine,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  takeRunArcKey,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from './usdcx-run';
import { USDCX_DECIMALS } from '../../../src/lib/usdcx/protocol';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

/**
 * The legs the live USDCx specs share: a Guardian or standard wallet funded by one public faucet grant, and a burn
 * through Send to a key on Arc or an L2 (`PayoutChain`, Arc by default). Their pure decisions live in usdcx-run.ts,
 * which has the unit tests; this file is the live wiring, run by
 * `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn|usdcx-burn-l2`.
 */

const VAULT_TIMEOUT_MS = 120_000;

/** A wallet's ids in each form the run needs: composite for the wallet, bare bech32 and hex for the Node oracle. */
export interface UsdcxWalletIds {
  address: string;
  bare: string;
  accountHex: string;
  /** The native (fee) faucet as the wallet discovered it, composite like every `feeFaucetId` the wallet writes. */
  native: string;
  nativeBare: string;
  nativeHex: string;
  baseFee: number;
}

/** The route and visibility of the wallet's page, for phase timeouts. */
export function pageWhere(wallet: GuardianAwareWalletPage): StepContext {
  return () => describePage(wallet.page.url(), () => wallet.page.evaluate(() => document.visibilityState));
}

/**
 * The native faucet and base fee the wallet discovered for itself, and the Node-side ids. The fee faucet comes from the
 * wallet, never from the public faucet API, whose `id` is its distributor wallet rather than the USDCx faucet.
 */
export async function resolveUsdcxIds(page: Page, address: string): Promise<UsdcxWalletIds> {
  const discovered = await pollUntil(
    'native asset discovery',
    async () => ({ native: await walletDiscoveredNativeFaucetId(page), baseFee: await walletDiscoveredBaseFee(page) }),
    found => found.native !== null && found.baseFee !== null,
    { timeoutMs: 120_000, intervalMs: 2_000 }
  );
  if (discovered.native === null || discovered.baseFee === null) {
    throw new Error('native asset discovery found nothing');
  }
  const bare = bareId(address);
  const nativeBare = bareId(discovered.native);
  return {
    address,
    bare,
    accountHex: await accountHex(bare),
    native: discovered.native,
    nativeBare,
    nativeHex: await accountHex(nativeBare),
    baseFee: discovered.baseFee
  };
}

async function currentAccountType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store: { getState?: () => { currentAccount?: { type?: string } | null } } | undefined = Reflect.get(
      window,
      '__TEST_STORE__'
    );
    return store?.getState?.().currentAccount?.type ?? '';
  });
}

/** Spec 5 step 1: a fresh Guardian wallet bound to `guardianUrl`, tracked before its first transaction. */
export async function createGuardianUsdcxWallet(wallet: GuardianAwareWalletPage, guardianUrl: string): Promise<string> {
  const { address } = await wallet.createGuardianWallet(guardianUrl);
  // A reused profile could hold another run's account, whose rows and vault would break every exact ledger here.
  if (!wallet.ownsProfile) throw new Error('wallet A runs on a profile this run did not create');
  // Before the grant consume, the account's first push: tracking that starts later finds no push to settle.
  wallet.trackGuardianCommitments();
  await pollUntil(
    'the new account binding to the Guardian',
    async () => ({ endpoint: await wallet.currentGuardianEndpoint(), type: await currentAccountType(wallet.page) }),
    bound => bound.endpoint === guardianUrl && bound.type === 'guardian',
    { timeoutMs: 120_000, intervalMs: 2_000 }
  );
  return address;
}

/** `waitForGuardianSettled`, timed; a missing push reads as tracking that started late. */
export async function settleGuardian(wallet: GuardianAwareWalletPage, timeoutMs: number): Promise<number> {
  const started = Date.now();
  await wallet.waitForGuardianSettled(timeoutMs).catch((error: unknown) => {
    throw explainSettleFailure(error);
  });
  return Date.now() - started;
}

/** The one consume row whose notes include `noteId`, once Completed; a Failed one fails the run with its stage. */
export async function waitForConsumeOf(
  page: Page,
  noteId: string,
  label: string,
  timeoutMs: number,
  where: StepContext
): Promise<TransactionRowSnapshot> {
  const wanted = noteId.toLowerCase();
  const row = await pollUntil(
    `${label} consume of note ${noteId}`,
    async () => {
      const rows = (await readTransactionRows(page)).filter(
        candidate => candidate.type === 'consume' && (candidate.noteIds ?? []).some(id => id.toLowerCase() === wanted)
      );
      if (rows.length > 1) {
        throw new Error(
          `${rows.length} consume rows carry note ${noteId}: ${rows.map(describeTransactionRow).join('; ')}`
        );
      }
      const [found] = rows;
      // Unconfirmed (4) waits for the node's verdict and keeps polling; only Completed ends the wait.
      if (found?.status === TxStatus.Failed) {
        throw new Error(
          `${label} consume ${found.id} failed at stage ${found.stage ?? 'unknown'}: ` +
            `${found.rawError ?? found.error ?? 'no error recorded'}`
        );
      }
      return found;
    },
    found => found?.status === TxStatus.Completed,
    { timeoutMs, intervalMs: 3_000, describe: () => where() }
  );
  if (!row) throw new Error(`${label} consume of note ${noteId} disappeared`);
  return row;
}

async function exactVault(
  page: Page,
  native: string,
  expected: bigint,
  terms: ReadonlyArray<readonly [string, bigint]>
): Promise<bigint> {
  await waitForVaultBalanceOfCurrentAccount(page, native, expected, { timeoutMs: VAULT_TIMEOUT_MS }).catch(
    (error: unknown) => {
      throw new Error(`ledger ${ledgerLine(terms)}: expected vault ${expected}; ${errorText(error)}`, { cause: error });
    }
  );
  return expected;
}

/**
 * A landed path (verifiedLandingRowFields in reconcile-unconfirmed.ts, landedRowFields in transaction/index.ts) records
 * no fee, so the fee is the vault's debit less the known terms, held to `0 < fee <= baseFee x FEE_RESERVE_MULTIPLE`
 * (Q5(d)).
 */
function landedFee(name: string, args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): FeeTerm {
  try {
    return boundedTerm(name, boundLandedFee(args));
  } catch (error) {
    throw new Error(`${name} took a landed path (no resultBytes, no resultReleasedAt): ${errorText(error)}`, {
      cause: error
    });
  }
}

/**
 * A Completed consume's fee and the vault after it. A consume that kept its result recorded its fee, so the vault
 * must land exactly; one that completed through a landed path recorded none, so its fee is bounded from the settled
 * vault instead (Q5(d)).
 */
export async function consumeFeeAndVault(
  page: Page,
  ids: UsdcxWalletIds,
  consume: TransactionRowSnapshot,
  ledger: { fee: string; vaultBefore: bigint; credit: bigint; terms: ReadonlyArray<readonly [string, bigint]> }
): Promise<{ fee: FeeTerm; vault: bigint }> {
  const path = consumeFeePath(consume);
  if (path.kind === 'result' && consume.feeFaucetId !== ids.native) {
    throw new Error(`consume ${consume.id} paid its fee in ${consume.feeFaucetId ?? 'nothing'}, not ${ids.native}`);
  }
  const vault =
    path.kind === 'result'
      ? await exactVault(page, ids.native, ledger.vaultBefore + ledger.credit - path.fee, [
          ...ledger.terms,
          [ledger.fee, path.fee]
        ])
      : await readSettledChange(() => vaultBalanceOfCurrentAccount(page, ids.native), ledger.vaultBefore, {
          timeoutMs: VAULT_TIMEOUT_MS,
          intervalMs: 4_000
        });
  const fee: FeeTerm =
    path.kind === 'result'
      ? { name: ledger.fee, amount: path.fee, kind: 'exact' }
      : landedFee(ledger.fee, {
          vaultDelta: ledger.vaultBefore - vault,
          // A consume credits the vault, so its known term enters the debit negated.
          knownTerms: -ledger.credit,
          baseFee: ids.baseFee
        });
  return { fee, vault };
}

export interface GrantFunding {
  grantNoteId: Hash;
  grant: bigint;
  grantTag?: number;
  consumeId: string;
  f0: FeeTerm;
  vault: bigint;
}

/**
 * Spec 5 step 3: one public faucet grant of the 10 USDCx tier (R19), which the service worker consumes by itself (a
 * claim call would add a second consume row). The grant consume is also the account's deploy.
 */
export async function fundFromPublicFaucet(
  page: Page,
  ids: UsdcxWalletIds,
  rpcUrl: string,
  where: StepContext
): Promise<GrantFunding> {
  const faucetApi = publicFaucetApiUrl('testnet');
  if (!faucetApi) throw new Error('the harness names no public faucet for testnet');
  // The 10 USDCx tier, not the Fund button's largest: an explicit amount is never re-asked at a cap, so a faucet that
  // drops the tier fails here, named.
  const { noteId } = await mintFromPublicFaucet(faucetApi, ids.bare, GRANT_UNITS);
  if (!isHash(noteId)) throw new Error(`the public faucet returned note id ${noteId}, not 32 bytes of hex`);
  await waitForPublicNoteCommitment(rpcUrl, noteId, 60_000);
  // G is what the node holds in the note, not what the faucet said it would grant.
  const grantNote = await note(rpcUrl, noteId);
  const asset = exactlyOne(
    grantNote.assets,
    `asset on grant note ${noteId}`,
    item => `${item.faucetHex} ${item.amount}`
  );
  expect(asset.faucetHex.toLowerCase(), 'the grant is the native (USDCx) asset').toBe(ids.nativeHex.toLowerCase());
  expect(asset.amount, 'the faucet granted the tier it was asked for').toBe(GRANT_UNITS);
  const consume = await waitForConsumeOf(page, noteId, 'grant', 90_000, where);
  const { fee: f0, vault } = await consumeFeeAndVault(page, ids, consume, {
    fee: 'f0',
    vaultBefore: 0n,
    credit: asset.amount,
    terms: [['G', asset.amount]]
  });
  if (vault < BURN_UNITS + GRANT_MARGIN_UNITS) {
    throw new Error(
      `faucet granted ${asset.amount}, need >= ${fromBaseUnits(BURN_UNITS + GRANT_MARGIN_UNITS, USDCX_DECIMALS)} ` +
        `USDCx after the ${f0.amount} fee`
    );
  }
  return { grantNoteId: noteId, grant: asset.amount, grantTag: grantNote.tag, consumeId: consume.id, f0, vault };
}

/** Spec 5 step 6: the burn through Send; resolves with the bridged-send rows that existed before it. */
export async function submitBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: { destination: Address; units: bigint; screenshotDir: string; payoutChain?: PayoutChain }
): Promise<ReadonlySet<string>> {
  // A Guardian burn is not requeued on a pending-delta 409 (REQUEUEABLE_ON_PENDING_CONFLICT in transaction/index.ts
  // leaves out bridged-send), so nothing may be in flight.
  assertNoGuardianOpInFlight(await readTransactionRows(wallet.page), ids.address);
  const prior = new Set((await readBridgedSendRows(wallet.page)).map(row => row.id));
  await bridgeOutUsdcx(wallet, {
    destAddress: opts.destination,
    amount: fromBaseUnits(opts.units, USDCX_DECIMALS),
    nativeTokenId: ids.native,
    nativeSymbol: await readNativeDisplaySymbol(wallet.page, ids.native),
    screenshotDir: opts.screenshotDir,
    payoutChain: opts.payoutChain
  });
  // The burn and destination watchers poll from the provider while a wallet route is visible.
  await wallet.navigateHome();
  return prior;
}

export interface BurnLeg {
  row: BridgedSendRow;
  burnNoteId: Hash;
  fee: FeeTerm;
  sponsorship: bigint;
  vault: bigint;
  oracle: BurnEvidence;
  /** The payout chain's block of the balance the wallet saved before the burn. */
  arcFromBlock: bigint;
  phases: PhaseTimeline;
}

export interface ConfirmBurnOptions {
  priorRowIds: ReadonlySet<string>;
  destination: Address;
  /** The harness's read of the key right before the burn (R21); the wallet's saved balance must equal it. */
  keySnapshot?: { balance: bigint; blockNumber: bigint };
  units: bigint;
  vaultBefore: bigint;
  rpcUrl: string;
  guardian: boolean;
  timeoutMs: number;
  where: StepContext;
  /** Where Circle pays the burn (default Arc): the chain and domain the node and the row must carry. */
  payoutChain?: PayoutChain;
}

/**
 * What a burn to `destination` on `chain` carries, on the node and on its row: the recipient, the chain id and the
 * destination's Circle domain (26, 6 or 3). The payout names Arc's domain instead, so the two are never compared.
 */
export function burnTarget(
  chain: PayoutChain,
  destination: Address
): { destination: string; network: number; domain: number } {
  return { destination: destination.toLowerCase(), network: chain.chainId, domain: chain.burnDomain };
}

async function burnVerdict(noteId: string | undefined, rpcUrl: string): Promise<string> {
  if (!noteId || !isHash(noteId)) return 'no burn note id to look up';
  try {
    if (!(await note(rpcUrl, noteId)).committed) return 'never committed (expired after the 20-block cap)';
    const spent = await nullifier(rpcUrl, noteId);
    return spent.committed
      ? `consumed by the faucet in block ${spent.blockNum ?? 'unknown'}`
      : 'committed, faucet has not consumed';
  } catch (error) {
    return `oracle unavailable (${errorText(error)})`;
  }
}

async function burnStuckReport(last: BridgedSendRow | undefined, rpcUrl: string, where: StepContext): Promise<string> {
  const burn = last?.extraInputs?.usdcxBurn;
  return [
    `status ${last?.status ?? 'no row'}, phase ${burn?.phase ?? 'none'}, lastError ${burn?.lastError ?? 'none'}, ` +
      `attemptCount ${burn?.attemptCount ?? 'unset'}, lastAttemptBlockNum ${burn?.lastAttemptBlockNum ?? 'unset'}`,
    await burnVerdict(burn?.noteId, rpcUrl),
    await where()
  ].join('; ');
}

/** The fee and sponsorship a burn's own outputs carry; they must name the row's burn note and fee exactly. */
async function decodeBurnTerms(
  resultBytes: string,
  row: BridgedSendRow,
  burnNoteId: Hash,
  ids: UsdcxWalletIds,
  units: bigint,
  liveSponsorship: bigint
): Promise<{ fee: bigint; sponsorship: bigint }> {
  const outputs = await burnOutputs({ resultBytesBase64: resultBytes, burnNoteId, faucetBech32: ids.nativeBare });
  const mismatches = [
    outputs.burn.noteId.toLowerCase() === burnNoteId.toLowerCase()
      ? null
      : `burn note ${outputs.burn.noteId}, row names ${burnNoteId}`,
    outputs.burn.amount === units ? null : `burn amount ${outputs.burn.amount}, sent ${units}`,
    outputs.sponsorship.amount === liveSponsorship
      ? null
      : `sponsorship ${outputs.sponsorship.amount}, live fee_schedule ${liveSponsorship}`,
    row.feeAmount === outputs.fee.amount.toString()
      ? null
      : `fee note ${outputs.fee.amount}, row feeAmount ${row.feeAmount ?? 'unset'}`,
    row.feeFaucetId === ids.native ? null : `fee paid in ${row.feeFaucetId ?? 'nothing'}, not ${ids.native}`
  ].filter((text): text is string => text !== null);
  if (mismatches.length > 0) throw new Error(`burn ${row.id} outputs disagree: ${mismatches.join('; ')}`);
  return { fee: outputs.fee.amount, sponsorship: outputs.sponsorship.amount };
}

/**
 * Spec 5 step 7: the burn row reaches `confirmed`, its outputs and the vault agree to the base unit, and the node
 * shows the row's burn note, consumed by the faucet. The first read that carries `resultBytes` is kept: the reaper
 * releases them 10 min after `completedAt`.
 */
export async function confirmBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: ConfirmBurnOptions
): Promise<BurnLeg> {
  const page = wallet.page;
  const phases = new PhaseTimeline('USDCx burn', ['pending', 'consuming', 'confirmed']);
  const kept: { withResult?: BridgedSendRow } = {};
  const row = await pollUntil(
    'USDCx burn row to reach confirmed',
    async () => {
      const rows = (await readBridgedSendRows(page)).filter(
        candidate => candidate.extraInputs?.provider === 'usdcx' && !opts.priorRowIds.has(candidate.id)
      );
      if (rows.length > 1) {
        throw new Error(`the burn queued ${rows.length} usdcx rows: ${rows.map(r => r.id).join(', ')}`);
      }
      const [found] = rows;
      // Unconfirmed (4) is pending: a burn whose submit outcome is unknown waits for the node's verdict.
      if (found?.status === TxStatus.Failed) throw new Error(burnFailureMessage(found));
      phases.record(found?.extraInputs?.usdcxBurn?.phase, Date.now());
      if (found?.resultBytes) kept.withResult ??= found;
      return found;
    },
    found => found?.status === TxStatus.Completed && found.extraInputs?.usdcxBurn?.phase === 'confirmed',
    {
      timeoutMs: opts.timeoutMs,
      intervalMs: 3_000,
      describe: last => burnStuckReport(last, opts.rpcUrl, opts.where)
    }
  );
  if (!row) throw new Error('the burn row disappeared');
  phases.assertMonotone();
  const burn = row.extraInputs?.usdcxBurn;
  if (!burn) throw new Error(`burn row ${row.id} has no usdcxBurn record`);
  const burnNoteId = burn.noteId;
  if (!isHash(burnNoteId)) throw new Error(`burn row ${row.id} names note ${burnNoteId}, not 32 bytes of hex`);
  const chain = opts.payoutChain ?? ARC_PAYOUT;
  const target = burnTarget(chain, opts.destination);

  // The node, not the row, proves the burn: its amount, tag, scheme-5 target and sender, and the faucet's consume.
  const oracle = await burnEvidence(opts.rpcUrl, {
    faucetBech32: ids.nativeBare,
    noteId: burnNoteId,
    senderBech32: ids.bare,
    domain: target.domain,
    recipient: opts.destination,
    amount: opts.units
  });
  expect(
    {
      amount: oracle.amount,
      tag: oracle.tag,
      sender: oracle.senderHex.toLowerCase(),
      domain: oracle.domain,
      recipient: oracle.recipient.toLowerCase(),
      nullifierCommitted: oracle.nullifierCommitted
    },
    `the node's view of burn note ${burnNoteId}`
  ).toEqual({
    amount: opts.units,
    tag: USDCX_BURN_TAG,
    sender: ids.accountHex.toLowerCase(),
    domain: target.domain,
    recipient: target.destination,
    nullifierCommitted: true
  });
  expect(oracle.scriptRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  // A missing schedule entry would read as a zero sponsorship and hide inside a bounded fee.
  if (oracle.sponsorshipUnits <= 0n) {
    throw new Error(`the faucet's fee_schedule names no sponsorship for burn root ${oracle.scriptRoot}`);
  }

  const resultRow = kept.withResult ?? row;
  const path = burnCompletionPath(resultRow);
  const decoded =
    path.kind === 'result'
      ? await decodeBurnTerms(path.resultBytes, resultRow, burnNoteId, ids, opts.units, oracle.sponsorshipUnits)
      : undefined;
  const sponsorship = decoded?.sponsorship ?? oracle.sponsorshipUnits;
  const terms: Array<readonly [string, bigint]> = [
    ['V1', opts.vaultBefore],
    ['N', opts.units],
    ['s', sponsorship]
  ];
  const vault = decoded
    ? await exactVault(page, ids.native, opts.vaultBefore - (opts.units + decoded.fee + sponsorship), [
        ...terms,
        ['f1', decoded.fee]
      ])
    : await readSettledChange(() => vaultBalanceOfCurrentAccount(page, ids.native), opts.vaultBefore, {
        timeoutMs: VAULT_TIMEOUT_MS,
        intervalMs: 4_000
      });
  const fee: FeeTerm = decoded
    ? { name: 'f1', amount: decoded.fee, kind: 'exact' }
    : landedFee('f1', {
        vaultDelta: opts.vaultBefore - vault,
        knownTerms: opts.units + sponsorship,
        baseFee: ids.baseFee
      });

  // Saved before the burn was queued (burn.ts:103,116-121): the wallet's own baseline for its payout check.
  const before = burn.destinationBalanceBefore;
  expect(before?.balance, 'the wallet saved the key balance before the burn').toMatch(/^\d+$/);
  expect(before?.blockNumber).toMatch(/^[1-9]\d*$/);
  if (opts.keySnapshot !== undefined && before?.balance !== opts.keySnapshot.balance.toString()) {
    throw new Error(
      `the wallet saved ${before?.balance} for the key at ${chain.label} block ${before?.blockNumber}, but the harness read ` +
        `${opts.keySnapshot.balance} at block ${opts.keySnapshot.blockNumber} right before the burn: something paid ` +
        'or spent from the key in between, so its payout cannot be proven'
    );
  }
  const requiredStages = opts.guardian ? ['creating-proposal', 'signing-proposal'] : [];
  expect(Object.keys(row.stageTimestamps ?? {})).toEqual(expect.arrayContaining(requiredStages));
  expect({
    destination: row.extraInputs?.destinationAddress?.toLowerCase(),
    network: row.extraInputs?.destinationNetwork,
    domain: burn.destinationDomain
  }).toEqual(target);
  expect(row.transactionId).toMatch(/^0x[0-9a-f]+$/);
  const unlisted = burnOutputNoteProblem(path, row, burnNoteId);
  if (unlisted !== undefined) throw new Error(unlisted);
  return {
    row,
    burnNoteId,
    fee,
    sponsorship,
    vault,
    oracle,
    arcFromBlock: BigInt(before?.blockNumber ?? '0'),
    phases
  };
}

/** What the payout step reads of a confirmed burn: its note id and the faucet's consume of it. */
export type ConsumedBurn = Pick<BurnLeg, 'burnNoteId'> & {
  oracle: Pick<BurnEvidence, 'consumeBlock' | 'consumeTimestampSec'>;
};

/** Spec 5 step 8 failure body: the payout key and its pre-burn read, the burn's consume and xReserve's pause flags. */
function payoutContext(
  arc: ArcReadDeps,
  chain: PayoutChain,
  label: string,
  snapshot: ArcUsdcSnapshot,
  burn: ConsumedBurn
): StepContext {
  return async () => {
    const flags = await readXReserveDomainState(arc).then(
      state =>
        `paused ${state.paused}, deposits paused ${state.depositsPaused}, withdrawals paused ${state.withdrawalsPaused}`,
      (error: unknown) => `pause flags unreadable (${errorText(error)})`
    );
    const consumedAt = new Date(burn.oracle.consumeTimestampSec * 1_000).toISOString();
    return (
      `${label} held ${snapshot.balance} at ${chain.label} block ` +
      `${snapshot.blockNumber} (read on ${arcHost(snapshot.endpoint)}); burn note ${burn.burnNoteId} consumed in ` +
      `Miden block ${burn.oracle.consumeBlock} at ${consumedAt}; xReserve ${flags}`
    );
  };
}

/** The Arc key a payout leg waits on: the role the evidence records and the label a failure names, never its key. */
export interface PayoutKey {
  key: ArcKey;
  role: string;
  /** The key's address and where it is kept, e.g. `harness key 0x... (~/.miden-e2e/arc-keys/harness.json)`. */
  label: string;
}

/** A payout key and its read right before a burn (R21), and the step that waits for that burn's payout (R22). */
export interface PayoutLeg {
  key: ArcKey;
  snapshot: ArcUsdcSnapshot;
  /**
   * Spec 5 step 8, D3 in delta mode: one AttestationUsed log whose mint calldata carries the burn note id and whose
   * value is the key's whole rise above `snapshot`, within PAYOUT_TIMEOUT_MS of the faucet's consume. Red means a user
   * was not paid in time.
   */
  waitForPayout(burn: ConsumedBurn, depositor: Hex): Promise<GatewayPayout>;
}

/**
 * The payout leg of a burn to `takeKey`'s key: `key_snapshot` reads the key right before the burn, and the test ends
 * only once `waitForPayout` has proven Circle paid exactly that burn, so no payout is left to land in a later run's
 * window (R22). Both steps write their evidence.
 */
export async function payoutLeg(
  step: NamedStep,
  opts: {
    takeKey: () => PayoutKey;
    arc: ArcReadDeps;
    /** The payout chain's reads (`payoutChain` set); absent, the payout is on Arc and read through `arc`. */
    payoutReads?: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { arc, evidence } = opts;
  // xReserve's pause flags are Arc's for every destination; the key is read and its payout proven where Circle pays.
  const reads = opts.payoutReads ?? arc;
  const chain = reads.payoutChain ?? ARC_PAYOUT;
  const { taken, snapshot } = await step('key_snapshot', opts.budget.keySnapshot, async () => {
    const taken = opts.takeKey();
    opts.secrets.push(taken.key.privateKey);
    return { taken, snapshot: await readArcUsdcSnapshot(taken.key.address, reads) };
  });
  const { key } = taken;
  evidence.ids.arcKey = key.address;
  evidence.ids.arcKeyRole = taken.role;
  evidence.ids.arcBalanceBefore = String(snapshot.balance);
  evidence.ids.arcSnapshotBlock = String(snapshot.blockNumber);
  // An Arc run's evidence keeps exactly the keys it always had.
  if (chain.chainId !== ARC_PAYOUT.chainId) evidence.ids.payoutChainId = String(chain.chainId);

  const waitForPayout = async (burn: ConsumedBurn, depositor: Hex): Promise<GatewayPayout> => {
    const consumeTsMs = burn.oracle.consumeTimestampSec * 1_000;
    const payout = await step(
      'payout',
      opts.budget.payout,
      () =>
        waitForGatewayPayout(
          {
            recipient: key.address,
            burnNoteId: burn.burnNoteId,
            burnUnits: BURN_UNITS,
            fromBlock: snapshot.blockNumber,
            balanceBefore: snapshot.balance,
            consumeTsMs,
            deadlineMs: consumeTsMs + PAYOUT_TIMEOUT_MS,
            depositor,
            minimumValue: minimumUsdcxPayout(chain.chainId, BURN_UNITS)
          },
          reads
        ),
      payoutContext(arc, chain, taken.label, snapshot, burn)
    );
    expect({ domain: payout.sourceDomain, total: payout.value + payout.fee }).toEqual({
      domain: chain.attestationSourceDomain,
      total: BURN_UNITS
    });
    evidence.hashes.payout = payout.transactionHash;
    evidence.fees.push({ name: 'circle payout fee', amount: payout.fee, kind: 'exact' });
    evidence.latenciesMs.consumeToPayout = payout.latencyMs;
    return payout;
  };
  return { key, snapshot, waitForPayout };
}

/** `payoutLeg` on the harness key `yarn e2e:real` handed the run (R21), which every extension burn pays. */
export async function harnessPayoutLeg(
  step: NamedStep,
  opts: {
    env: Record<string, string | undefined>;
    arc: ArcReadDeps;
    payoutReads?: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { env, ...rest } = opts;
  return payoutLeg(step, {
    ...rest,
    takeKey: () => {
      const { key, role } = takeRunArcKey(env);
      expect(role, `${opts.evidence.suite} burns to the harness key`).toBe('harness');
      return { key, role, label: `harness key ${key.address} (${HARNESS_ARC_KEY_FILE})` };
    }
  });
}

/**
 * Spec 5 step 8b (Q6, a hard gate): the wallet's own destination check confirms the payout Circle made, at exactly the
 * balance the payout gate proved and no earlier than its log. The caller puts the wallet on Home, where the check runs,
 * and keeps its own details-page checks; this returns when the confirmation was first read.
 */
export async function waitForWalletPayoutConfirmation(opts: {
  /** The wallet's bridged-send rows, read the platform's way. */
  readRows: () => Promise<BridgedSendRow[]>;
  rowId: string;
  /** The payout chain's block of the balance the wallet saved before the burn. */
  arcFromBlock: bigint;
  payout: Pick<GatewayPayout, 'value' | 'balance' | 'logBlock'>;
  key: Pick<ArcKey, 'address'>;
  /** The payout chain's reads; their `payoutChain` (Arc when absent) names the wallet's own RPC there. */
  arc: ArcReadDeps;
  where: StepContext;
  evidence: RunEvidence;
}): Promise<number> {
  const { payout, key, arc } = opts;
  const chain = arc.payoutChain ?? ARC_PAYOUT;
  const clock = arc.clock ?? realArcClock;
  const row = await pollUntil(
    'the wallet confirming the payout',
    async () => (await opts.readRows()).find(candidate => candidate.id === opts.rowId),
    found => found?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed !== undefined,
    {
      timeoutMs: WALLET_CONFIRM_TIMEOUT_MS,
      intervalMs: 3_000,
      now: () => clock.now(),
      sleep: ms => clock.sleep(ms),
      describe: async last => {
        const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
        const walletRpc = await readArcUsdc(key.address, { ...arc, endpoints: [chain.walletRpcUrl] }).then(
          balance => `${chain.walletRpcName} reads ${balance}`,
          // viem's error text quotes the URL; arc.io's carries no project id, so Arc's message is unchanged.
          (error: unknown) => `${chain.walletRpcName} failed: ${redactProjectId(errorText(error))}`
        );
        const before = JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore);
        return (
          `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
          `${before}, key balance now ${keyNow}, ${walletRpc}; ${await opts.where()}`
        );
      }
    }
  );
  const confirmedAt = clock.now();
  const confirmed = row?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed;
  const confirmedBlock = BigInt(confirmed?.blockNumber ?? '0');
  expect(
    {
      balance: confirmed?.balance,
      afterSnapshot: confirmedBlock > opts.arcFromBlock,
      atOrAfterPayout: confirmedBlock >= payout.logBlock
    },
    `confirmation at ${chain.label} block ${confirmedBlock}, snapshot ${opts.arcFromBlock}, ` +
      `payout log ${payout.logBlock}, ` +
      `${payout.balance - payout.value} on the key before the burn`
  ).toEqual({ balance: payout.balance.toString(), afterSnapshot: true, atOrAfterPayout: true });
  opts.evidence.ids.walletConfirmedBalance = String(confirmed?.balance);
  return confirmedAt;
}

/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name the chain and link the key. */
export async function assertBurnDetails(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  destination: Address,
  chain: PayoutChain = ARC_PAYOUT
): Promise<void> {
  await openHistoryDetails(wallet, rowId);
  const page = wallet.page;
  await expect(page.getByTestId('history-status-pill')).toHaveText(
    anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
  );
  await expect(page.locator(`a[href="${chain.explorer}/address/${destination}" i]`)).toBeVisible();
  await expect(page.getByText(chain.networkName, { exact: true }).first()).toBeVisible();
}

/** The details pill of `rowId` as it reads once rendered. */
export async function historyPill(wallet: GuardianAwareWalletPage, rowId: string): Promise<string> {
  await openHistoryDetails(wallet, rowId);
  const pill = wallet.page.getByTestId('history-status-pill');
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  return ((await pill.textContent()) ?? '').trim();
}

/**
 * The receiving-tx link's hash if the open details page renders it within `timeoutMs`, else null. The link is a
 * best-effort RPC match the details page looks up once (Q7), so its absence is recorded, never failed.
 */
export async function receivingTxHash(
  page: Page,
  timeoutMs: number,
  chain: PayoutChain = ARC_PAYOUT
): Promise<string | null> {
  const link = page.locator(`a[href^="${chain.explorer}/tx/"]`).first();
  const rendered = await link.waitFor({ state: 'attached', timeout: timeoutMs }).then(
    () => true,
    () => false
  );
  if (!rendered) return null;
  const href = (await link.getAttribute('href')) ?? '';
  return href.slice(href.lastIndexOf('/') + 1).toLowerCase();
}

/** Attaches the run's evidence; throws instead when a private key would be written. */
export async function attachEvidence(
  info: TestInfo,
  name: string,
  evidence: RunEvidence,
  secrets: readonly string[]
): Promise<void> {
  await info.attach(name, { body: evidenceJson(evidence, secrets), contentType: 'application/json' });
}
