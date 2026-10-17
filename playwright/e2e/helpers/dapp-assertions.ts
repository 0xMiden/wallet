import { expect, type Page } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';

import {
  vaultBalanceOfCurrentAccount,
  vaultReadingOfCurrentAccount,
  waitForVaultBalanceOfCurrentAccount,
  type VaultReading
} from './balance-truth';
import type { DappAxis } from './dapp-axis';
import { CellDeadlineExceeded, deadlineIn, InfrastructureFault, type CellContext } from './dapp-cells';
import {
  canonicalAddress,
  isForeignConsume,
  normalizeHex,
  storeHoldsSyncSince,
  syncedSince,
  type NonCurrentRead
} from './dapp-gates';
import {
  describeTransactionRow,
  readTransactionRow,
  readTransactionRows,
  TxStatus,
  USER_CANCELLED_REASON,
  type TransactionRowSnapshot
} from './history';
import { callDapp, ensureUnlocked, pendingNotes, selectAccountIfNeeded, unwrap, type DappHandle } from './test-dapp';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { NoteTypeName, OutputNoteView } from '../test-dapp/protocol';

/**
 * The spec's assertion model (section 5): every write is asserted from the dApp's, the wallet's and the chain's side,
 * in that order, then Guardian, balances and the recipient. Vault reads are scoped to the executing account, so a
 * second account in the wallet can neither hide nor inflate a debit.
 */

/** The executing side of a write: the wallet, the dApp connected to it and the account it runs as. */
export interface WriteSide {
  wallet: GuardianAwareWalletPage;
  dapp: DappHandle;
  axis: DappAxis;
  /** The wallet's store key for the executing account (what `selectAccount` takes). */
  account: string;
  /** The same account as the page reports it after connect, for chain reads. */
  accountIdHex: string;
  nativeFaucetId: string;
  /** Who may send this account a note during the journey (`Journey.senders`); anyone else is a third party. */
  journeySenders(): readonly string[];
}

/** What a write is measured against, captured after the cell's quiesce and before the request. */
export interface Baseline {
  vault: Record<string, bigint>;
  /** `null` for an account the node has never seen (a first transaction). */
  commitmentHex: string | null;
  rowIds: string[];
  /** Unix seconds just before the reads, on the scale of a row's `completedAt`; the vault holds every row completed before. */
  capturedAtSec: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Re-reads until `done`, each read raced against the cell's deadline; gives up with the last value it saw. With
 * `bounded`, the read already races that deadline itself (a `callDapp` given `ctx.deadline`) and is not raced again: a
 * second race on the same deadline wins the tie and hides the node failure `callDapp` reports when the deadline cuts it.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  ctx: CellContext,
  { intervalMs = 2_000, bounded = false }: { intervalMs?: number; bounded?: boolean } = {}
): Promise<T> {
  for (;;) {
    const value = await (bounded ? read() : ctx.deadline.race(read(), what));
    if (done(value)) return value;
    if (ctx.deadline.remainingMs() < intervalMs) throw new Error(`${what}: last read ${JSON.stringify(value)}`);
    await sleep(intervalMs);
  }
}

// What the wait for a fresh wallet sync leaves of the cell's deadline for the question to the node after it: a round trip
// and a few of callDapp's 2 s retries.
const NODE_QUESTION_RESERVE_MS = 15_000;

/**
 * The current account's nonzero vault once the store holds a sync stamped after `sinceMs` (`storeHoldsSyncSince`): every
 * transaction the account completed before then is in it, a third party's consume the store had not polled among them.
 * Syncs are forced only while the last one published is older or another account's. A wallet sync needs the node, so a
 * wait that runs out asks `dapp`'s node: one that fails throws `ChainUnavailable`, and only one that answers leaves the
 * failure the wallet's. With `faucetIds`, the store and the sync are read and compared on those faucets alone.
 */
export async function vaultSyncedAfter(
  wallet: Pick<GuardianAwareWalletPage, 'page' | 'triggerSync'>,
  dapp: DappHandle,
  sinceMs: number,
  ctx: CellContext,
  faucetIds?: readonly string[]
): Promise<Record<string, string>> {
  const what = 'the store holding a wallet sync after the baseline stamp';
  const wait = deadlineIn(Math.max(0, ctx.deadline.remainingMs() - NODE_QUESTION_RESERVE_MS), ctx.deadline.label);
  const read = async () => {
    const reading = await vaultReadingOfCurrentAccount(wallet.page, faucetIds);
    if (syncedSince(reading, sinceMs)) return reading;
    await wallet.triggerSync(true);
    return vaultReadingOfCurrentAccount(wallet.page, faucetIds);
  };
  let last: VaultReading | null = null;
  let ended = '';
  try {
    for (;;) {
      last = await wait.race(read(), what);
      if (storeHoldsSyncSince(last, sinceMs)) return last.store;
      if (wait.remainingMs() < 1_000) break;
      await sleep(1_000);
    }
  } catch (error) {
    // A forced sync that never settles (a stalled node) is cut here; any other failure is not the wait running out.
    if (!(error instanceof CellDeadlineExceeded)) throw error;
    ended = `; ${error.message}`;
  }
  await callDapp(dapp, 'syncHeight', {}, ctx.deadline);
  throw new Error(`${what}, the dApp's node answering: last read ${JSON.stringify(last)}${ended}`);
}

/** Baselines come after the quiesce, so nothing else moves these balances while the cell runs. */
export async function captureBaseline(
  side: WriteSide,
  faucetIds: readonly string[],
  ctx: CellContext
): Promise<Baseline> {
  const capturedAtSec = Math.floor(Date.now() / 1000);
  await selectAccountIfNeeded(side.wallet, side.account);
  const ids = [...new Set([...faucetIds, side.nativeFaucetId])];
  const synced = await vaultSyncedAfter(side.wallet, side.dapp, capturedAtSec * 1000, ctx, ids);
  const vault = Object.fromEntries(ids.map(id => [id, BigInt(synced[id] ?? '0')]));
  const chain = await callDapp(side.dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline);
  return {
    vault,
    commitmentHex: chain.found ? (chain.commitmentHex ?? null) : null,
    rowIds: (await readTransactionRows(side.wallet.page)).map(row => row.id),
    capturedAtSec
  };
}

export interface ReceivedNote {
  noteId: string;
  faucetId: string;
  amount: bigint;
}

/**
 * The recipient side, per note id: each note is discovered with exactly its amount, and the claim credits exactly
 * what was pending. Reading the pending sum just before the claim keeps the check exact when another write's note
 * to the same recipient is pending too (M4).
 */
export async function expectReceivedByRecipient(
  wallet: GuardianAwareWalletPage,
  notes: readonly ReceivedNote[],
  ctx: CellContext
): Promise<void> {
  if (notes.length === 0) return;
  const wanted = notes.map(note => normalizeHex(note.noteId));
  const pending = await pollUntil(
    () => pendingNotes(wallet.page),
    list => wanted.every(id => list.some(note => normalizeHex(note.id) === id)),
    'recipient discovered every note',
    ctx
  );
  // The faucet too: the credit below sums pending entries by faucet id, so an entry under another id would leave
  // nothing to wait for and the claim check would pass on an unchanged vault.
  const discovered = notes.map(note => pending.find(entry => normalizeHex(entry.id) === normalizeHex(note.noteId)));
  expect(discovered.map(entry => ({ faucetId: entry?.faucetId, amount: entry?.amountBaseUnits }))).toEqual(
    notes.map(note => ({ faucetId: note.faucetId, amount: note.amount.toString() }))
  );
  const faucets = [...new Set(notes.map(note => note.faucetId))];
  const before = new Map<string, bigint>();
  for (const faucetId of faucets) before.set(faucetId, await vaultBalanceOfCurrentAccount(wallet.page, faucetId));
  await wallet.claimAllNotes(ctx.deadline.remainingMs());
  for (const faucetId of faucets) {
    const incoming = pending
      .filter(entry => entry.faucetId === faucetId)
      .reduce((sum, entry) => sum + BigInt(entry.amountBaseUnits), 0n);
    await waitForVaultBalanceOfCurrentAccount(wallet.page, faucetId, (before.get(faucetId) ?? 0n) + incoming, {
      timeoutMs: ctx.deadline.remainingMs()
    });
  }
}

export interface ExpectedNote {
  /** Known in advance for dApp-built requests; wallet-built sends learn it from waitForTransaction. */
  noteId?: string;
  noteType: NoteTypeName;
  minBlock?: number;
  /**
   * Compared on chain only when set (spec section 5, step 3): a dApp-built note's words as the page built them. A
   * wallet-built send's own attachment is no dApp's to set and differs by kind: single-sig sends carry the SDK's
   * empty `new NoteAttachment()`, one zero word (src/lib/miden/sdk/helpers.ts:270-275), and a Guardian P2ID proposal
   * none (multisig-client 0.18.0 transaction/p2id.js:72-73).
   */
  attachmentWordsHex?: string[];
  /** Wallet B receives and claims it (`expectReceivedByRecipient`). */
  recipient?: { wallet: GuardianAwareWalletPage; faucetId: string; amount: bigint };
}
export interface ExpectedWrite {
  txId: string;
  outputNotes: ExpectedNote[];
  consumedNullifiers: string[];
}
export interface WriteResult {
  txId: string;
  txHash: string;
  outputNotes: OutputNoteView[];
  feeAmount: bigint;
  row: TransactionRowSnapshot;
}

async function recordRow(page: Page, txId: string, ctx: CellContext): Promise<TransactionRowSnapshot | null> {
  const row = await readTransactionRow(page, txId);
  ctx.evidence.rowStatus = row?.status;
  ctx.evidence.stage = row?.stage;
  const text = [row?.error, row?.rawError].filter((part): part is string => typeof part === 'string').join(' | ');
  ctx.evidence.rowError = text.length > 0 ? text : undefined;
  return row;
}

// Notes with a known id pair by id; the rest pair by type, which is unambiguous for one wallet-built note per write.
function pairNotes(
  expected: readonly ExpectedNote[],
  actual: readonly OutputNoteView[]
): Array<[ExpectedNote, OutputNoteView]> {
  const remaining = [...actual];
  const take = (match: (note: OutputNoteView) => boolean): OutputNoteView => {
    const index = remaining.findIndex(match);
    const [found] = index < 0 ? [] : remaining.splice(index, 1);
    if (found === undefined) throw new Error(`no output note left to pair with ${JSON.stringify(expected)}`);
    return found;
  };
  const known = expected.filter(note => note.noteId !== undefined);
  const unknown = expected.filter(note => note.noteId === undefined);
  return [
    ...known.map((note): [ExpectedNote, OutputNoteView] => [
      note,
      take(out => normalizeHex(out.noteId) === normalizeHex(note.noteId ?? ''))
    ]),
    ...unknown.map((note): [ExpectedNote, OutputNoteView] => [note, take(out => out.noteType === note.noteType)])
  ];
}

/**
 * Asserts `writes`, all made from `side` after `baseline`, to the end. `vaultDelta` is the net change per faucet the
 * writes make before fees; the recorded fees come off the native asset on top of it. The writes must be all the account
 * ran since the baseline.
 */
export async function expectWritesToTheEnd(
  side: WriteSide,
  baseline: Baseline,
  writes: readonly ExpectedWrite[],
  vaultDelta: Readonly<Record<string, bigint>>,
  ctx: CellContext
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const pairs: Array<Array<[ExpectedNote, OutputNoteView]>> = [];
  for (const write of writes) {
    // 1. The dApp's view, right after approval, as a real dApp asks for it. A wait that outlives the cell still
    // records where the row stopped, so a known-bug signature can match it.
    const waited = await callDapp(side.dapp, 'waitForTransaction', { txId: write.txId }, ctx.deadline).catch(
      async (error: unknown) => {
        await recordRow(side.wallet.page, write.txId, ctx);
        throw error;
      }
    );
    const row = await recordRow(side.wallet.page, write.txId, ctx);
    const value = unwrap(waited, `waitForTransaction(${write.txId})`, ctx);
    expect(value.txHash, 'txHash').toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      value.outputNotes.every(note => note.isSameSdkNote),
      'output notes are the page SDK Note class'
    ).toBe(true);
    expect(value.outputNotes.map(note => note.noteType).sort(), 'output note types, fee note excluded').toEqual(
      write.outputNotes.map(note => note.noteType).sort()
    );
    // 2. The wallet's view.
    expect(row?.status, row === null ? 'row missing' : describeTransactionRow(row)).toBe(TxStatus.Completed);
    expect(row?.transactionId).toBe(value.txHash);
    pairs.push(pairNotes(write.outputNotes, value.outputNotes));
    results.push({
      txId: write.txId,
      txHash: value.txHash,
      outputNotes: value.outputNotes,
      feeAmount: BigInt(row?.feeAmount ?? '0'),
      row: row ?? { id: write.txId }
    });
  }

  // 3. The chain's view, through the dApp's own RpcClient, independent of the wallet. Each read takes the deadline, so
  // a read the node fails is asked again rather than ending the cell, and is polled `bounded` (callDapp).
  for (const [index, write] of writes.entries()) {
    for (const [expected, actual] of pairs[index] ?? []) {
      const onChain = await pollUntil(
        () => callDapp(side.dapp, 'chainNote', { noteId: actual.noteId }, ctx.deadline),
        note => note.found,
        `note ${actual.noteId} on chain`,
        ctx,
        { bounded: true }
      );
      expect({ sender: normalizeHex(onChain.senderHex ?? ''), type: onChain.noteType }).toEqual({
        sender: normalizeHex(side.accountIdHex),
        type: expected.noteType
      });
      expect(onChain.blockNum ?? -1).toBeGreaterThanOrEqual(expected.minBlock ?? 0);
      const attachments = expected.attachmentWordsHex === undefined ? undefined : (onChain.attachmentWordsHex ?? []);
      expect(attachments, 'attachment words on chain').toEqual(expected.attachmentWordsHex);
    }
    for (const nullifier of write.consumedNullifiers) {
      await pollUntil(
        () => callDapp(side.dapp, 'chainNullifier', { nullifierHex: nullifier }, ctx.deadline),
        spent => spent.committedAt !== null,
        `nullifier ${nullifier} committed`,
        ctx,
        { bounded: true }
      );
    }
  }
  const chain = await pollUntil(
    () => callDapp(side.dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline),
    account => account.found && account.commitmentHex !== baseline.commitmentHex,
    'account commitment moved on chain',
    ctx,
    { bounded: true }
  );

  // 4. Guardian only, as axis data (spec section 5, step 4).
  await ctx.deadline.race(side.axis.settle(side.wallet), 'Guardian settle');
  expect(await side.axis.guardianCommitment(side.wallet, side.account)).toBe(
    side.axis.expected.guardianCommitment(chain.commitmentHex ?? '')
  );

  // 5. Balances, exact; the fee comes off the native asset.
  await ensureUnlocked(side.wallet);
  await selectAccountIfNeeded(side.wallet, side.account);
  const fee = results.reduce((sum, result) => sum + result.feeAmount, 0n);
  const deltas: Record<string, bigint> = {
    ...vaultDelta,
    [side.nativeFaucetId]: (vaultDelta[side.nativeFaucetId] ?? 0n) - fee
  };
  const txIds = writes.map(write => write.txId);
  await unlessAThirdPartyMovedIt(side, baseline, txIds, async () => {
    for (const [faucetId, delta] of Object.entries(deltas)) {
      await waitForVaultBalanceOfCurrentAccount(side.wallet.page, faucetId, (baseline.vault[faucetId] ?? 0n) + delta, {
        timeoutMs: ctx.deadline.remainingMs()
      });
    }
  });

  // 6. The recipient, per note id.
  const received = pairs.flat().flatMap(([expected, actual]) =>
    expected.recipient === undefined
      ? []
      : [
          {
            wallet: expected.recipient.wallet,
            note: { noteId: actual.noteId, faucetId: expected.recipient.faucetId, amount: expected.recipient.amount }
          }
        ]
  );
  for (const wallet of new Set(received.map(entry => entry.wallet))) {
    await expectReceivedByRecipient(
      wallet,
      received.filter(entry => entry.wallet === wallet).map(entry => entry.note),
      ctx
    );
  }

  // 7. Nothing else ran. The waits in step 5 pass the moment the vault reads the expected value, so a requeue that
  // became a second payment and lands later goes unseen there: the vault is read again across forced syncs, and the
  // account's rows since the baseline must be these writes' and no others.
  const expectedVault: Record<string, bigint> = {};
  for (const faucetId of new Set([...Object.keys(baseline.vault), ...Object.keys(deltas)])) {
    expectedVault[faucetId] = (baseline.vault[faucetId] ?? 0n) + (deltas[faucetId] ?? 0n);
  }
  await unlessAThirdPartyMovedIt(side, baseline, txIds, () =>
    expectVaultHolds(side, expectedVault, 'vault after the writes', ctx)
  );
  const others = ownRowsBesides(side, baseline, txIds, await readTransactionRows(side.wallet.page));
  expect(others.map(describeTransactionRow), 'rows the account ran besides these writes').toEqual([]);
  return results;
}

/** Whose vault a third-party check reads, and who counts as the journey. */
export type VaultOwner = Pick<WriteSide, 'wallet' | 'account' | 'journeySenders'>;
/** The rows the account held, and when they were read: a third party's move counts from then on. */
export type RowWindow = Pick<Baseline, 'rowIds' | 'capturedAtSec'>;

/** Whether a row is the executing account's; a row naming no account counts as the account's. */
const ofAccount = (owner: VaultOwner, entry: TransactionRowSnapshot) =>
  entry.accountId === undefined || canonicalAddress(entry.accountId) === canonicalAddress(owner.account);

/**
 * The executing account's rows the baseline did not hold, other than `expected`. A consume of a third party's note is
 * left out: nothing the cell asked for can make one (spec section 5, Writes step 7).
 */
function ownRowsBesides(
  owner: VaultOwner,
  since: RowWindow,
  expected: readonly string[],
  rows: readonly TransactionRowSnapshot[]
): TransactionRowSnapshot[] {
  return rows.filter(
    entry =>
      !since.rowIds.includes(entry.id) &&
      !expected.includes(entry.id) &&
      ofAccount(owner, entry) &&
      !isForeignConsume(entry, owner.journeySenders())
  );
}

/**
 * What makes a failed exact check of the account's vault the environment's, for this cell alone: a consume of a third
 * party's note moved the account since `since` (finished since its capture, or still running), and the account ran
 * nothing else of its own besides `expected`. `null` when the failure stays the check's.
 */
async function thirdPartyMoveFault(
  owner: VaultOwner,
  since: RowWindow,
  expected: readonly string[],
  failure: unknown
): Promise<InfrastructureFault | null> {
  const rows = await readTransactionRows(owner.wallet.page);
  const moved = rows.filter(
    entry =>
      ofAccount(owner, entry) &&
      isForeignConsume(entry, owner.journeySenders()) &&
      (!since.rowIds.includes(entry.id) || entry.completedAt === undefined || entry.completedAt >= since.capturedAtSec)
  );
  if (moved.length === 0 || ownRowsBesides(owner, since, expected, rows).length > 0) return null;
  const consumes = moved.map(
    entry => `${entry.id} consumed ${(entry.noteIds ?? [entry.noteId]).join(', ')} from ${entry.secondaryAccountId}`
  );
  return new InfrastructureFault(
    `a note from outside the journey moved ${owner.account}'s vault during the cell (${consumes.join('; ')}): ` +
      `${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`,
    { abortsLeg: false, cause: failure }
  );
}

/** Runs an exact vault check; its failure is the environment's only as `thirdPartyMoveFault` says. */
async function unlessAThirdPartyMovedIt(
  side: WriteSide,
  baseline: Baseline,
  expected: readonly string[],
  check: () => Promise<void>
): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw (await thirdPartyMoveFault(side, baseline, expected, error)) ?? error;
  }
}

/**
 * M4-reads: a read served after its popup a vault other than its account's own, captured at `since`. A move by a third
 * party's note on that account explains it (`thirdPartyMoveFault`, the read making no row), unless the vault served is
 * the other account's: a leak stays the wallet's. Anything else is left to the per-read rule.
 */
export async function unlessAThirdPartyMovedARead(
  owner: VaultOwner,
  since: RowWindow,
  read: NonCurrentRead,
  otherOwn: Record<string, string>
): Promise<void> {
  const { prompted, served, own } = read;
  if (!prompted || served === null || isDeepStrictEqual(served, own)) return;
  if (isDeepStrictEqual(served, otherOwn)) return;
  const mismatch = new Error(`served ${JSON.stringify(served)}, not its own ${JSON.stringify(own)}`);
  const fault = await thirdPartyMoveFault(owner, since, [], mismatch);
  if (fault !== null) throw fault;
}

/** The exact refusal a dApp sees; `message` as a pattern only where the wallet interpolates into it. */
export const refusal = (name: string, message: string | RegExp, causeName?: string) => ({
  ok: false,
  error: expect.objectContaining({
    name,
    message: typeof message === 'string' ? message : expect.stringMatching(message),
    ...(causeName === undefined ? {} : { causeName })
  })
});

export async function expectNoNewRows(side: WriteSide, baseline: Baseline): Promise<void> {
  const added = (await readTransactionRows(side.wallet.page)).filter(
    row => !baseline.rowIds.includes(row.id) && !isForeignConsume(row, side.journeySenders())
  );
  expect(added.map(describeTransactionRow), 'rows a refused request added').toEqual([]);
}

/** Equal to `expected` across two forced syncs, so a late debit has time to show. */
async function expectVaultHolds(
  side: WriteSide,
  expected: Record<string, bigint>,
  what: string,
  ctx: CellContext
): Promise<void> {
  await selectAccountIfNeeded(side.wallet, side.account);
  for (let lap = 0; lap < 2; lap += 1) {
    await ctx.deadline.race(side.wallet.triggerSync(true), `sync before the ${what} check`);
    const now: Record<string, bigint> = {};
    for (const id of Object.keys(expected)) now[id] = await vaultBalanceOfCurrentAccount(side.wallet.page, id);
    expect(now, `${what} after sync ${lap + 1}`).toEqual(expected);
  }
}

/**
 * Unchanged across two forced syncs, so a late debit has time to show. `expected` names every row the cell made, with no
 * default: a row of the cell's own left out turns a third party's move of the vault into the wallet's failure.
 */
export async function expectVaultUnchanged(
  side: WriteSide,
  baseline: Baseline,
  ctx: CellContext,
  expected: readonly string[]
): Promise<void> {
  await unlessAThirdPartyMovedIt(side, baseline, expected, () => expectVaultHolds(side, baseline.vault, 'vault', ctx));
}

/**
 * R4: a row the user cancelled while it was Queued, so the dApp's wait is refused with the cancel and the vault never
 * moved; the cancelled row is the cell's own.
 */
export async function expectCancelledWhileQueued(
  side: WriteSide,
  baseline: Baseline,
  txId: string,
  ctx: CellContext
): Promise<void> {
  expect(await callDapp(side.dapp, 'waitForTransaction', { txId }, ctx.deadline)).toEqual(
    refusal('WalletTransactionError', USER_CANCELLED_REASON)
  );
  await expectVaultUnchanged(side, baseline, ctx, [txId]);
}

/** Spec section 5, "Negative paths": stage and text are pinned, because waitForTransaction returns row.error verbatim. */
export async function expectFailedAfterEnqueue(
  side: WriteSide,
  baseline: Baseline,
  txId: string,
  expected: { stage: string; error: string },
  ctx: CellContext
): Promise<void> {
  await pollUntil(
    () => readTransactionRow(side.wallet.page, txId),
    row => row?.status === TxStatus.Failed || row?.status === TxStatus.Completed,
    `row ${txId} terminal`,
    ctx
  );
  const row = await recordRow(side.wallet.page, txId, ctx);
  expect(row?.status, row === null ? 'row missing' : describeTransactionRow(row)).toBe(TxStatus.Failed);
  expect(row?.stage).toBe(expected.stage);
  expect(`${row?.error ?? ''} ${row?.rawError ?? ''}`).toContain(expected.error);
  expect(await callDapp(side.dapp, 'waitForTransaction', { txId }, ctx.deadline)).toEqual({
    ok: false,
    error: { name: 'WalletTransactionError', message: row?.error ?? '' }
  });
  await expectVaultUnchanged(side, baseline, ctx, [txId]);
}

/**
 * Spec section 5, "Previews". Soft: a declared view is recorded and the cell goes on to approve, so one run can report
 * a preview bug and the failure that follows it. `amount: null` is a request that moves nothing but the fee (X8c);
 * `storageChanged`, when set, is the value the "Storage changed" row must show, and any verified view must show the row.
 */
export async function expectVerifiedPreview(
  popup: Page,
  expected: { amount: RegExp | null; outputNotes: number; storageChanged?: boolean; timeoutMs?: number },
  ctx: CellContext
): Promise<void> {
  const verified = popup.locator('[data-testid="tx-asset-view"][data-mode="verified"]');
  const failed = popup.getByTestId('tx-simulation-failed');
  // The declared view renders first while the simulation runs; wait for an outcome, not for the first paint.
  await expect(verified.or(failed)).toBeVisible({ timeout: expected.timeoutMs ?? 60_000 });
  if ((await verified.count()) === 0) {
    ctx.softFail('preview-verified', `declared view, simulation failed shown: ${await failed.isVisible()}`, {
      previewSimulationFailed: await failed.isVisible()
    });
    return;
  }
  // The heading renders with the view, before any row's token metadata resolves, so its absence is not a race.
  const moves = expected.amount === null ? 0 : 1;
  await expect(verified.getByText('Asset changes', { exact: true })).toHaveCount(moves);
  const rows = verified.locator('[data-verified="true"]');
  await expect(expected.amount === null ? rows : rows.filter({ hasText: expected.amount })).toHaveCount(moves);
  await expect(popup.getByTestId('tx-output-notes-created')).toHaveText(String(expected.outputNotes));
  const storage = popup.getByTestId('tx-storage-changed');
  const changed = expected.storageChanged;
  await expect(storage).toHaveAttribute('data-changed', changed === undefined ? /^(true|false)$/ : String(changed));
  await expect(storage).toHaveText(changed === undefined ? /^(Yes|No)$/ : changed ? 'Yes' : 'No');
  await expect(failed).toHaveCount(0);
}
