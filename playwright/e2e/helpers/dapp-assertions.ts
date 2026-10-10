import { expect, type Page } from '@playwright/test';

import { vaultBalanceOfCurrentAccount, waitForVaultBalanceOfCurrentAccount } from './balance-truth';
import type { DappAxis } from './dapp-axis';
import type { CellContext } from './dapp-cells';
import { canonicalAddress, normalizeHex } from './dapp-gates';
import {
  describeTransactionRow,
  readTransactionRow,
  readTransactionRows,
  TxStatus,
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
}

/** What a write is measured against, captured after the cell's quiesce and before the request. */
export interface Baseline {
  vault: Record<string, bigint>;
  /** `null` for an account the node has never seen (a first transaction). */
  commitmentHex: string | null;
  rowIds: string[];
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Re-reads until `done`, each read raced against the cell's deadline; gives up with the last value it saw. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  ctx: CellContext,
  intervalMs = 2_000
): Promise<T> {
  for (;;) {
    const value = await ctx.deadline.race(read(), what);
    if (done(value)) return value;
    if (ctx.deadline.remainingMs() < intervalMs) throw new Error(`${what}: last read ${JSON.stringify(value)}`);
    await sleep(intervalMs);
  }
}

/** Baselines come after the quiesce, so nothing else moves these balances while the cell runs. */
export async function captureBaseline(
  side: WriteSide,
  faucetIds: readonly string[],
  ctx: CellContext
): Promise<Baseline> {
  await selectAccountIfNeeded(side.wallet, side.account);
  const ids = [...new Set([...faucetIds, side.nativeFaucetId])];
  const vault: Record<string, bigint> = {};
  for (const id of ids) vault[id] = await vaultBalanceOfCurrentAccount(side.wallet.page, id);
  const chain = await callDapp(side.dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline);
  return {
    vault,
    commitmentHex: chain.found ? (chain.commitmentHex ?? null) : null,
    rowIds: (await readTransactionRows(side.wallet.page)).map(row => row.id)
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
  // a read the node fails is asked again rather than ending the cell (callDapp).
  for (const [index, write] of writes.entries()) {
    for (const [expected, actual] of pairs[index] ?? []) {
      const onChain = await pollUntil(
        () => callDapp(side.dapp, 'chainNote', { noteId: actual.noteId }, ctx.deadline),
        note => note.found,
        `note ${actual.noteId} on chain`,
        ctx
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
        ctx
      );
    }
  }
  const chain = await pollUntil(
    () => callDapp(side.dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline),
    account => account.found && account.commitmentHex !== baseline.commitmentHex,
    'account commitment moved on chain',
    ctx
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
  for (const [faucetId, delta] of Object.entries(deltas)) {
    await waitForVaultBalanceOfCurrentAccount(side.wallet.page, faucetId, (baseline.vault[faucetId] ?? 0n) + delta, {
      timeoutMs: ctx.deadline.remainingMs()
    });
  }

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
  await expectVaultHolds(side, expectedVault, 'vault after the writes', ctx);
  const txIds = new Set(writes.map(write => write.txId));
  const others = (await rowsOfAccountSince(side, baseline)).filter(entry => !txIds.has(entry.id));
  expect(others.map(describeTransactionRow), 'rows the account ran besides these writes').toEqual([]);
  return results;
}

/** The executing account's rows the baseline did not hold; a row naming no account counts as the account's. */
async function rowsOfAccountSince(side: WriteSide, baseline: Baseline): Promise<TransactionRowSnapshot[]> {
  const account = canonicalAddress(side.account);
  return (await readTransactionRows(side.wallet.page)).filter(
    entry =>
      !baseline.rowIds.includes(entry.id) &&
      (entry.accountId === undefined || canonicalAddress(entry.accountId) === account)
  );
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
  const added = (await readTransactionRows(side.wallet.page)).filter(row => !baseline.rowIds.includes(row.id));
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

/** Unchanged across two forced syncs, so a late debit has time to show. */
export async function expectVaultUnchanged(side: WriteSide, baseline: Baseline, ctx: CellContext): Promise<void> {
  await expectVaultHolds(side, baseline.vault, 'vault', ctx);
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
  await expectVaultUnchanged(side, baseline, ctx);
}

/**
 * Spec section 5, "Previews". Soft: a declared view is recorded (K4 on Guardian) and the cell goes on to approve, so
 * one run reports both K4 and K3.
 */
export async function expectVerifiedPreview(
  popup: Page,
  expected: { amount: RegExp; outputNotes: number; timeoutMs?: number },
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
  await expect(verified.locator('[data-verified="true"]').filter({ hasText: expected.amount })).toHaveCount(1);
  await expect(popup.getByTestId('tx-output-notes-created')).toHaveText(String(expected.outputNotes));
  await expect(failed).toHaveCount(0);
}
