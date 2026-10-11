import { expect, type Page, type TestInfo } from '@playwright/test';
import { isHash, type Address, type Hash } from 'viem';

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
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  BURN_UNITS,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  USDCX_BURN_TAG
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
  type FeeTerm,
  type RunEvidence,
  type StepContext
} from './usdcx-run';
import { USDCX_DECIMALS } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

/**
 * The legs the live USDCx specs share: a Guardian or standard wallet funded by one public faucet grant, and a burn
 * through Send to an Arc key. Their pure decisions live in usdcx-run.ts, which has the unit tests; this file is the
 * live wiring, run by `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn`.
 */

const VAULT_TIMEOUT_MS = 120_000;
const ARC_EXPLORER = ARC_TESTNET.blockExplorers.default.url;

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
  opts: { destination: Address; units: bigint; screenshotDir: string }
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
    screenshotDir: opts.screenshotDir
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
  arcFromBlock: bigint;
  phases: PhaseTimeline;
}

export interface ConfirmBurnOptions {
  priorRowIds: ReadonlySet<string>;
  destination: Address;
  units: bigint;
  vaultBefore: bigint;
  rpcUrl: string;
  guardian: boolean;
  timeoutMs: number;
  where: StepContext;
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

  // The node, not the row, proves the burn: its amount, tag, scheme-5 target and sender, and the faucet's consume.
  const oracle = await burnEvidence(opts.rpcUrl, {
    faucetBech32: ids.nativeBare,
    noteId: burnNoteId,
    senderBech32: ids.bare,
    domain: ARC_CIRCLE_DOMAIN,
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
    domain: ARC_CIRCLE_DOMAIN,
    recipient: opts.destination.toLowerCase(),
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

  // Saved before the burn was queued (burn.ts:103,116-121); the payout scan starts at its block.
  const before = burn.destinationBalanceBefore;
  expect(before?.balance, 'a fresh Arc key holds no USDC before the burn').toBe('0');
  expect(before?.blockNumber).toMatch(/^[1-9]\d*$/);
  const requiredStages = opts.guardian ? ['creating-proposal', 'signing-proposal'] : [];
  expect(Object.keys(row.stageTimestamps ?? {})).toEqual(expect.arrayContaining(requiredStages));
  expect({
    destination: row.extraInputs?.destinationAddress?.toLowerCase(),
    network: row.extraInputs?.destinationNetwork,
    domain: burn.destinationDomain
  }).toEqual({ destination: opts.destination.toLowerCase(), network: ARC_CHAIN_ID, domain: ARC_CIRCLE_DOMAIN });
  expect(row.transactionId).toMatch(/^0x[0-9a-f]+$/);
  expect(row.outputNoteIds ?? []).toContain(burnNoteId);
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

/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name Arc Testnet and link the key. */
export async function assertBurnDetails(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  destination: Address
): Promise<void> {
  await openHistoryDetails(wallet, rowId);
  const page = wallet.page;
  await expect(page.getByTestId('history-status-pill')).toHaveText(
    anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
  );
  await expect(page.locator(`a[href="${ARC_EXPLORER}/address/${destination}" i]`)).toBeVisible();
  await expect(page.getByText(ARC_TESTNET.name, { exact: true }).first()).toBeVisible();
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
export async function receivingTxHash(page: Page, timeoutMs: number): Promise<string | null> {
  const link = page.locator(`a[href^="${ARC_EXPLORER}/tx/"]`).first();
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
