import { expect } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';

import { pollUntil } from './dapp-assertions';
import { CellDeadlineExceeded, HarnessFault, InfrastructureFault, type CellContext } from './dapp-cells';
import { canonicalAddress, isForeignConsume, normalizeHex } from './dapp-gates';
import type { MobileDapp, MobileJourney } from './dapp-mobile-journey';
import { readRows, selectAccountIfNeeded, vaultOf, type MobileWallet } from './dapp-mobile-wallet';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from './history';
import { beforeMobileDeadline } from './mobile-store-reads';
import { TOKEN } from './money-path';
import { unwrap } from './test-dapp';
import type { NoteTypeName, OutputNoteView } from '../test-dapp/protocol';

/**
 * Spec section 5's write model on a mobile leg: the dApp's view, the wallet's row, the chain through the page's own
 * RpcClient, the Guardian settle, exact balances from the store, the recipient's claim, and nothing else run. The
 * wallet is read through its store and IndexedDB over the webview (dapp-mobile-wallet.ts). Each step's duration goes
 * to the cell's evidence (`stepDurationsMs`), so a budget is resized from a run (ruling C-P9).
 */

/** Whose rows and vault a check reads, and who counts as the journey. */
export interface RowOwner {
  readonly j: MobileJourney;
  readonly wallet: MobileWallet;
  /** The wallet's store key for the account. */
  readonly account: string;
}
/** The executing side of a write: wallet A's primary account, as dApp one is connected to it. */
export interface MobileSide extends RowOwner {
  readonly dapp: MobileDapp;
  readonly accountIdHex: string;
}
/** The rows the account held, and when they were read: a third party's move counts from then on. */
export interface RowWindow {
  rowIds: string[];
  capturedAtSec: number;
}
export interface MobileBaseline extends RowWindow {
  vault: Record<string, bigint>;
  /** `null` for an account the node has never seen. */
  commitmentHex: string | null;
}
export interface MobileExpectedNote {
  /** Known in advance for dApp-built requests; wallet-built sends learn it from waitForTransaction. */
  noteId?: string;
  noteType: NoteTypeName;
  minBlock?: number;
  attachmentWordsHex?: string[];
  /** What B receives and claims from this note, in TST base units. */
  toB?: bigint;
}
export interface MobileWrite {
  txId: string;
  outputNotes: MobileExpectedNote[];
  consumedNullifiers: string[];
}
export interface MobileWriteResult {
  txHash: string;
  outputNotes: OutputNoteView[];
  feeAmount: bigint;
  row: TransactionRowSnapshot;
}

/** Two reads one wallet sync apart: mobile syncs itself every 3 s (useSyncTrigger). */
const SYNC_APART_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const units = (vault: Record<string, bigint>): Record<string, string> =>
  Object.fromEntries(Object.entries(vault).map(([id, amount]) => [id, amount.toString()]));

export async function rowOwner(j: MobileJourney): Promise<RowOwner> {
  return { j, wallet: j.walletA, account: await j.account('primary') };
}

export async function mobileSideOf(j: MobileJourney): Promise<MobileSide> {
  const view = await j.call('session', {});
  if (view.connected === null) throw new HarnessFault(`dApp ${j.dapp.label} is not connected`);
  return {
    j,
    wallet: j.walletA,
    dapp: j.dapp,
    account: await j.account('primary'),
    accountIdHex: view.connected.accountIdHex
  };
}

export async function captureRowWindow(wallet: MobileWallet, ctx?: CellContext): Promise<RowWindow> {
  const capturedAtSec = Math.floor(Date.now() / 1000);
  const rows = await beforeMobileDeadline(ctx?.deadline, 'the baseline rows', () => readRows(wallet, ctx?.deadline));
  return { rowIds: rows.map(row => row.id), capturedAtSec };
}

/** The vault once two reads a sync apart agree, so every transaction completed before the first read is in it. */
export async function stableVault(
  wallet: MobileWallet,
  ids: readonly string[],
  ctx: CellContext
): Promise<Record<string, bigint>> {
  let last = await beforeMobileDeadline(ctx.deadline, 'the vault', () => vaultOf(wallet, ids, ctx.deadline));
  for (;;) {
    await beforeMobileDeadline(ctx.deadline, 'one wallet sync', () => sleep(SYNC_APART_MS));
    const next = await beforeMobileDeadline(ctx.deadline, 'the vault a sync later', () =>
      vaultOf(wallet, ids, ctx.deadline)
    );
    if (isDeepStrictEqual(next, last)) return next;
    last = next;
  }
}

/** Runs one step of a write and records how long it took in the cell's evidence, also when the step fails. */
export async function timed<T>(ctx: CellContext, step: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    ctx.evidence.stepDurationsMs = { ...ctx.evidence.stepDurationsMs, [step]: Date.now() - startedAt };
  }
}

/** Baselines come after the quiesce, so nothing else moves these balances while the cell runs. */
export function captureMobileBaseline(
  side: MobileSide,
  faucetIds: readonly string[],
  ctx: CellContext
): Promise<MobileBaseline> {
  return timed(ctx, 'baseline', async () => {
    await beforeMobileDeadline(ctx.deadline, 'account selection', () =>
      selectAccountIfNeeded(side.wallet, side.account, ctx.deadline)
    );
    const since = await captureRowWindow(side.wallet, ctx);
    const vault = await stableVault(side.wallet, [...new Set([...faucetIds, side.j.native.tokenId])], ctx);
    const chain = await beforeMobileDeadline(ctx.deadline, 'the baseline account on chain', () =>
      side.j.call('chainAccount', { accountId: side.accountIdHex }, ctx.deadline)
    );
    return { ...since, vault, commitmentHex: chain.found ? (chain.commitmentHex ?? null) : null };
  });
}

async function recordRow(owner: RowOwner, txId: string, ctx: CellContext): Promise<TransactionRowSnapshot | null> {
  const rows = await beforeMobileDeadline(ctx.deadline, 'the diagnostic rows', () =>
    readRows(owner.wallet, ctx.deadline)
  );
  const row = rows.find(entry => entry.id === txId) ?? null;
  ctx.evidence.rowStatus = row?.status;
  ctx.evidence.stage = row?.stage;
  const text = [row?.error, row?.rawError].filter((part): part is string => typeof part === 'string').join(' | ');
  ctx.evidence.rowError = text.length > 0 ? text : undefined;
  return row;
}

/** Notes with a known id pair by id; the rest pair by type, which is unambiguous for one wallet-built note per write. */
export function pairNotes(
  expected: readonly MobileExpectedNote[],
  actual: readonly OutputNoteView[]
): Array<[MobileExpectedNote, OutputNoteView]> {
  const remaining = [...actual];
  const take = (match: (note: OutputNoteView) => boolean, note: MobileExpectedNote): OutputNoteView => {
    const index = remaining.findIndex(match);
    const [found] = index < 0 ? [] : remaining.splice(index, 1);
    if (found === undefined)
      throw new Error(
        `no output note left to pair with ${JSON.stringify(note, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`
      );
    return found;
  };
  return [
    ...expected
      .filter(note => note.noteId !== undefined)
      .map((note): [MobileExpectedNote, OutputNoteView] => [
        note,
        take(out => normalizeHex(out.noteId) === normalizeHex(note.noteId ?? ''), note)
      ]),
    ...expected
      .filter(note => note.noteId === undefined)
      .map((note): [MobileExpectedNote, OutputNoteView] => [note, take(out => out.noteType === note.noteType, note)])
  ];
}

const ofAccount = (account: string, entry: TransactionRowSnapshot): boolean =>
  entry.accountId === undefined || canonicalAddress(entry.accountId) === canonicalAddress(account);

/** The account's rows `since` did not hold, other than `expected`; a consume of a third party's note is left out. */
export function ownRowsBesides(
  account: string,
  senders: readonly string[],
  since: RowWindow,
  expected: readonly string[],
  rows: readonly TransactionRowSnapshot[]
): TransactionRowSnapshot[] {
  return rows.filter(
    entry =>
      !since.rowIds.includes(entry.id) &&
      !expected.includes(entry.id) &&
      ofAccount(account, entry) &&
      !isForeignConsume(entry, senders)
  );
}

/** A failed exact vault check is the environment's when only a third party's consume moved the account since `since`. */
async function thirdPartyMoveFault(
  owner: RowOwner,
  since: RowWindow,
  expected: readonly string[],
  failure: unknown,
  ctx: CellContext
): Promise<InfrastructureFault | null> {
  const rows = await beforeMobileDeadline(ctx.deadline, 'rows after the vault failure', () =>
    readRows(owner.wallet, ctx.deadline)
  );
  const senders = owner.j.senders();
  const moved = rows.filter(
    entry =>
      ofAccount(owner.account, entry) &&
      isForeignConsume(entry, senders) &&
      (!since.rowIds.includes(entry.id) || entry.completedAt === undefined || entry.completedAt >= since.capturedAtSec)
  );
  if (moved.length === 0 || ownRowsBesides(owner.account, senders, since, expected, rows).length > 0) return null;
  const consumes = moved.map(
    entry => `${entry.id} consumed ${(entry.noteIds ?? [entry.noteId]).join(', ')} from ${entry.secondaryAccountId}`
  );
  return new InfrastructureFault(
    `a note from outside the journey moved ${owner.account}'s vault during the cell (${consumes.join('; ')}): ` +
      `${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`,
    { abortsLeg: false, cause: failure }
  );
}

async function unlessAThirdPartyMovedIt(
  owner: RowOwner,
  since: RowWindow,
  expected: readonly string[],
  ctx: CellContext,
  check: () => Promise<void>
): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof CellDeadlineExceeded || error instanceof HarnessFault || ctx.deadline.remainingMs() <= 0)
      throw error;
    let fault: InfrastructureFault | null = null;
    try {
      fault = await thirdPartyMoveFault(owner, since, expected, error, ctx);
    } catch (diagnostic) {
      if (!(diagnostic instanceof CellDeadlineExceeded)) throw diagnostic;
    }
    throw fault ?? error;
  }
}

/** B claims what the cell sent it, and its vault rises by exactly that. */
async function expectReceivedByB(j: MobileJourney, amount: bigint, ctx: CellContext): Promise<void> {
  if (amount === 0n) return;
  const token = j.tokenFaucetId;
  const before =
    (
      await beforeMobileDeadline(ctx.deadline, "wallet B's baseline vault", () =>
        vaultOf(j.walletB, [token], ctx.deadline)
      )
    )[token] ?? 0n;
  await beforeMobileDeadline(ctx.deadline, "wallet B's claim", () => {
    const claim = j.walletB.claimAllNotes(ctx.deadline.remainingMs(), [j.cliFaucetId]);
    j.recipientClaim = { cellId: ctx.deadline.label, promise: claim };
    return claim;
  });
  j.recipientClaim = undefined;
  const want = (before + amount).toString();
  await pollUntil(
    async () =>
      (
        (await beforeMobileDeadline(ctx.deadline, "wallet B's vault", () => vaultOf(j.walletB, [token], ctx.deadline)))[
          token
        ] ?? 0n
      ).toString(),
    held => held === want,
    `wallet B's ${TOKEN} at ${want}`,
    ctx,
    { intervalMs: 3_000 }
  );
}

/**
 * Asserts one write from `side` after `baseline`, to the end. `vaultDelta` is the net change per faucet before the fee;
 * the row's fee comes off the native asset on top of it. The write must be all the account ran since the baseline.
 * B's claim starts once the notes are on chain and runs beside A's chain, settle and vault checks (ruling C-P9).
 */
export async function expectMobileWriteToTheEnd(
  side: MobileSide,
  baseline: MobileBaseline,
  write: MobileWrite,
  vaultDelta: Readonly<Record<string, bigint>>,
  ctx: CellContext
): Promise<MobileWriteResult> {
  for (const note of write.outputNotes) {
    if (note.noteId !== undefined) side.j.outputNoteIds.add(normalizeHex(note.noteId));
  }
  // 1. The dApp's view; a wait that outlives the cell still records where the row stopped.
  const waited = await timed(ctx, 'dappView', () =>
    beforeMobileDeadline(ctx.deadline, 'the dApp transaction view', () =>
      side.j.call('waitForTransaction', { txId: write.txId }, ctx.deadline)
    ).catch(async (error: unknown) => {
      if (ctx.deadline.remainingMs() > 0 && !(error instanceof HarnessFault)) await recordRow(side, write.txId, ctx);
      throw error;
    })
  );
  const row = await recordRow(side, write.txId, ctx);
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
  const pairs = pairNotes(write.outputNotes, value.outputNotes);
  for (const [, actual] of pairs) side.j.outputNoteIds.add(normalizeHex(actual.noteId));

  // 3. The notes on chain, through the page's own RpcClient, independent of the wallet.
  await timed(ctx, 'notesOnChain', async () => {
    for (const [expected, actual] of pairs) {
      const onChain = await pollUntil(
        () =>
          beforeMobileDeadline(ctx.deadline, 'the chain note', () =>
            side.j.call('chainNote', { noteId: actual.noteId }, ctx.deadline)
          ),
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
  });

  // B proves beside steps 5-7; if its raw claim outlives this cell, the next quiesce must join it before driving B.
  const toB = pairs.reduce((sum, [expected]) => sum + (expected.toB ?? 0n), 0n);
  const received = timed(ctx, 'recipient', () => expectReceivedByB(side.j, toB, ctx));
  void received.catch(() => undefined);

  const feeAmount = BigInt(row?.feeAmount ?? '0');
  const native = side.j.native.tokenId;
  const expectedVault: Record<string, bigint> = {};
  for (const faucetId of new Set([...Object.keys(baseline.vault), ...Object.keys(vaultDelta), native])) {
    expectedVault[faucetId] =
      (baseline.vault[faucetId] ?? 0n) + (vaultDelta[faucetId] ?? 0n) - (faucetId === native ? feeAmount : 0n);
  }
  const ids = Object.keys(expectedVault);
  const checkA = async (): Promise<void> => {
    // 5. The nullifiers the write spent, and the account's commitment moved on chain.
    const chain = await timed(ctx, 'accountOnChain', async () => {
      for (const nullifierHex of write.consumedNullifiers) {
        await pollUntil(
          () =>
            beforeMobileDeadline(ctx.deadline, 'the chain nullifier', () =>
              side.j.call('chainNullifier', { nullifierHex }, ctx.deadline)
            ),
          spent => spent.committedAt !== null,
          `nullifier ${nullifierHex} committed`,
          ctx,
          { bounded: true }
        );
      }
      return pollUntil(
        () =>
          beforeMobileDeadline(ctx.deadline, 'the account on chain', () =>
            side.j.call('chainAccount', { accountId: side.accountIdHex }, ctx.deadline)
          ),
        account => account.found && account.commitmentHex !== baseline.commitmentHex,
        'account commitment moved on chain',
        ctx,
        { bounded: true }
      );
    });
    // 6. Guardian only: the operator holds what the chain holds (dapp-mobile-axis.ts).
    await timed(ctx, 'guardianSettle', () =>
      beforeMobileDeadline(ctx.deadline, 'Guardian settle', () =>
        side.j.axis.settle(side.wallet, side.account, chain.commitmentHex ?? null, ctx.deadline)
      )
    );
    // 7. Balances, exact; the fee comes off the native asset.
    await beforeMobileDeadline(ctx.deadline, 'account selection', () =>
      selectAccountIfNeeded(side.wallet, side.account, ctx.deadline)
    );
    await timed(ctx, 'vault', () =>
      unlessAThirdPartyMovedIt(side, baseline, [write.txId], ctx, async () => {
        await pollUntil(
          async () =>
            units(
              await beforeMobileDeadline(ctx.deadline, 'the vault after the write', () =>
                vaultOf(side.wallet, ids, ctx.deadline)
              )
            ),
          vault => isDeepStrictEqual(vault, units(expectedVault)),
          `the vault at ${JSON.stringify(units(expectedVault))}`,
          ctx,
          { intervalMs: 3_000 }
        );
      })
    );
  };
  await checkA().catch(async (error: unknown) => {
    await received.catch(() => undefined);
    throw error;
  });
  await received;

  // 8. Nothing else ran: the vault holds a sync later, and the account ran no other row.
  await timed(ctx, 'nothingElse', async () => {
    await unlessAThirdPartyMovedIt(side, baseline, [write.txId], ctx, async () => {
      await beforeMobileDeadline(ctx.deadline, 'one wallet sync', () => sleep(SYNC_APART_MS));
      expect(
        units(
          await beforeMobileDeadline(ctx.deadline, 'the vault a sync after the write', () =>
            vaultOf(side.wallet, ids, ctx.deadline)
          )
        ),
        'the vault a sync after the write'
      ).toEqual(units(expectedVault));
    });
    const rows = await beforeMobileDeadline(ctx.deadline, 'rows after the write', () =>
      readRows(side.wallet, ctx.deadline)
    );
    const others = ownRowsBesides(side.account, side.j.senders(), baseline, [write.txId], rows);
    expect(others.map(describeTransactionRow), 'rows the account ran besides this write').toEqual([]);
  });
  return { txHash: value.txHash, outputNotes: value.outputNotes, feeAmount, row: row ?? { id: write.txId } };
}

export async function expectNoNewMobileRows(owner: RowOwner, since: RowWindow, ctx?: CellContext): Promise<void> {
  const rows = await beforeMobileDeadline(ctx?.deadline, 'rows after the refusal', () =>
    readRows(owner.wallet, ctx?.deadline)
  );
  expect(
    since.rowIds.filter(id => !rows.some(row => row.id === id)),
    'baseline rows missing after the refusal'
  ).toEqual([]);
  const added = ownRowsBesides(owner.account, owner.j.senders(), since, [], rows);
  expect(added.map(describeTransactionRow), 'rows a refused request added').toEqual([]);
}

/** Spec section 5, "Negative paths": stage and text pinned, since waitForTransaction returns the row's error verbatim. */
export async function expectFailedAfterEnqueueMobile(
  side: MobileSide,
  baseline: MobileBaseline,
  txId: string,
  expected: { stage: string; error: string },
  ctx: CellContext
): Promise<void> {
  await pollUntil(
    async () =>
      (
        await beforeMobileDeadline(ctx.deadline, 'the failed write rows', () => readRows(side.wallet, ctx.deadline))
      ).find(row => row.id === txId) ?? null,
    row => row?.status === TxStatus.Failed || row?.status === TxStatus.Completed,
    `row ${txId} terminal`,
    ctx
  );
  const row = await recordRow(side, txId, ctx);
  expect(row?.status, row === null ? 'row missing' : describeTransactionRow(row)).toBe(TxStatus.Failed);
  expect(row?.stage).toBe(expected.stage);
  expect(`${row?.error ?? ''} ${row?.rawError ?? ''}`).toContain(expected.error);
  expect(
    await beforeMobileDeadline(ctx.deadline, 'the dApp failed transaction view', () =>
      side.j.call('waitForTransaction', { txId }, ctx.deadline)
    )
  ).toEqual({
    ok: false,
    error: { name: 'WalletTransactionError', message: row?.error ?? '' }
  });
  await unlessAThirdPartyMovedIt(side, baseline, [txId], ctx, async () => {
    expect(
      units(await stableVault(side.wallet, Object.keys(baseline.vault), ctx)),
      'the vault after the failed write'
    ).toEqual(units(baseline.vault));
  });
}
