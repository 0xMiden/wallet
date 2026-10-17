import { expect } from '@playwright/test';

import { HarnessFault, type CellContext } from './dapp-cells';
import { callOn, type DappChannel } from './dapp-channel';
import type { DappDriverTarget } from '../harness/dapp-browser-driver';
import type { DappError } from '../test-dapp/protocol';

/**
 * The approval sheet a dApp request opens on mobile (DappConfirmationModal.tsx), read and answered over the wallet
 * webview. It is a Radix dialog with a generated id, so it is found from its one fixed anchor, the origin in its title,
 * up to the enclosing dialog, never as the first dialog on the page; Approve, Deny and each message line carry test ids
 * (spec 3.4). A request is answered only once the previous sheet has closed, so an exit animation is never read as the
 * next sheet (spike plan change 11).
 */
export const SHEET_IDS = {
  origin: 'dapp-confirmation-origin',
  approve: 'dapp-confirmation-approve',
  deny: 'dapp-confirmation-deny',
  message: 'dapp-confirmation-message'
} as const;

export type SheetWallet = Pick<DappDriverTarget, 'evalJs'>;
export interface SheetView {
  origin: string | null;
  messages: string[];
  approveEnabled: boolean;
}
export interface SeenSheet extends SheetView {
  /** When the driver started the request: the wallet's 120 s auto-decline counts from no earlier. */
  sentAt: number;
  seenAt: number;
}
/** A dApp page answered through its channel, beside the wallet whose sheet its requests open. */
export interface SheetHost {
  readonly wallet: SheetWallet;
  readonly channel: DappChannel;
  readonly origin: string;
}
export interface SheetPlan {
  /** `none` presses nothing and takes the wallet's own answer (R7). */
  decision: 'approve' | 'deny' | 'none';
  /** Ticks the standing private-data box first, for an `Auto` connect. */
  tickStandingAccess?: boolean;
  /** Runs while the sheet is open, before the decision. */
  whileOpen?: (sheet: SeenSheet) => Promise<void>;
}

const SHEET_POLL_MS = 250;
/** The spike's sheets closed 542-680 ms after a click. */
const SHEET_CLOSE_MS = 10_000;
const PRESS_MS = 30_000;
/** An answer reached the driver 288-898 ms after the sheet closed, and the next command 4-7 ms after (plan change 9). */
const RESULT_GRACE_MS = 10_000;
const LIVENESS_MS = 5_000;

const FIND =
  `var a = document.querySelector('[data-testid="${SHEET_IDS.origin}"]'); ` +
  `var d = a ? a.closest('[role="dialog"]') : null;`;
const READ =
  `${FIND} if (!d) return null; var b = d.querySelector('[data-testid="${SHEET_IDS.approve}"]'); ` +
  `return { origin: a.getAttribute('title'), messages: Array.prototype.map.call(` +
  `d.querySelectorAll('[data-testid="${SHEET_IDS.message}"]'), function (m) { return (m.textContent || '').trim(); }), ` +
  `approveEnabled: !!b && !b.disabled };`;
const press = (id: string): string =>
  `${FIND} if (!d) return 'no-sheet'; var b = d.querySelector('[data-testid="${id}"]'); ` +
  `if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';`;
const TICK =
  `${FIND} if (!d) return 'no-sheet'; var box = d.querySelector('#dapp-standing-private-data'); ` +
  `if (!box) return 'no-box'; if (!box.checked) box.click(); return box.checked ? 'ticked' : 'unticked';`;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      last = await read();
      if (done(last)) return last;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const seen = lastError === undefined ? `value ${JSON.stringify(last)}` : `error ${String(lastError)}`;
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last ${seen}`);
    }
    await sleep(SHEET_POLL_MS);
  }
}

export function readSheet(wallet: SheetWallet): Promise<SheetView | null> {
  return wallet.evalJs<SheetView | null>(READ);
}

export async function waitForSheetClosed(wallet: SheetWallet, timeoutMs: number): Promise<number> {
  await until(
    'the approval sheet to close',
    () => readSheet(wallet),
    sheet => sheet === null,
    timeoutMs
  );
  return Date.now();
}

/** Clicks Approve once it is enabled, or Deny, and returns when it did. */
export async function pressSheet(
  wallet: SheetWallet,
  action: 'approve' | 'deny',
  timeoutMs = PRESS_MS
): Promise<number> {
  const id = action === 'approve' ? SHEET_IDS.approve : SHEET_IDS.deny;
  await until(
    `${action} on the approval sheet`,
    () => wallet.evalJs<string>(press(id)),
    state => state === 'clicked',
    timeoutMs
  );
  return Date.now();
}

export async function tickStandingAccess(wallet: SheetWallet): Promise<void> {
  await until(
    'the standing private-data box ticked',
    () => wallet.evalJs<string>(TICK),
    state => state === 'ticked',
    PRESS_MS
  );
}

/** Denies whatever sheet is open: one queue serves every origin (`getDappQueue`, actions.ts:109-113), so none may stay. */
export async function denyOpenSheet(wallet: SheetWallet): Promise<void> {
  if ((await readSheet(wallet)) === null) return;
  await pressSheet(wallet, 'deny');
  await waitForSheetClosed(wallet, SHEET_CLOSE_MS);
}

function watchForSheet(wallet: SheetWallet): { seen: Promise<SheetView & { seenAt: number }>; stop(): void } {
  let stopped = false;
  const seen = (async (): Promise<SheetView & { seenAt: number }> => {
    for (;;) {
      // A stopped watch never settles: the race it was in is over.
      if (stopped) return new Promise<never>(() => undefined);
      const sheet = await readSheet(wallet).catch(() => null);
      if (sheet !== null) return { ...sheet, seenAt: Date.now() };
      await sleep(SHEET_POLL_MS);
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
    }
  };
}

async function noEarlierSheet(wallet: SheetWallet): Promise<void> {
  try {
    await waitForSheetClosed(wallet, SHEET_CLOSE_MS);
  } catch {
    throw new HarnessFault(
      `an earlier approval sheet is still open after ${SHEET_CLOSE_MS} ms, so the next one could not be told apart`
    );
  }
}

const failedOutcome = (value: unknown): value is { ok: false; error: DappError } =>
  typeof value === 'object' && value !== null && Reflect.get(value, 'ok') === false;

function delay(ms: number): { done: Promise<null>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/**
 * The answer once the sheet has closed. Past the grace the page is asked for its state once: an answer means it is
 * alive and the wallet is still working; silence means the channel lost the page, which no wallet verdict may absorb.
 */
async function answerAfterClose<T>(host: SheetHost, pending: Promise<T>, ctx: CellContext): Promise<T> {
  const grace = delay(RESULT_GRACE_MS);
  let quick: { value: T } | null;
  try {
    quick = await Promise.race([pending.then(value => ({ value })), grace.done]);
  } finally {
    grace.cancel();
  }
  if (quick !== null) return quick.value;
  const alive = await host.channel.send('__state', {}, LIVENESS_MS).then(
    () => true,
    () => false
  );
  if (!alive) {
    throw new HarnessFault(
      `dApp ${host.channel.label}: no answer ${RESULT_GRACE_MS} ms after the sheet closed, and no __state answer within ${LIVENESS_MS} ms`
    );
  }
  return ctx.deadline.race(pending, 'the answer after the sheet closed');
}

/**
 * Starts a request and answers the sheet it opens. A request the wallet settles before any sheet is recorded
 * (`popupOpened: false`, the error) and fails the cell; a sheet naming another origin is left for the restore.
 */
export async function answerSheet<T>(
  host: SheetHost,
  start: () => Promise<T>,
  plan: SheetPlan,
  ctx: CellContext
): Promise<{ result: T; sheet: SeenSheet; answeredAt: number }> {
  await noEarlierSheet(host.wallet);
  const sentAt = Date.now();
  const pending = start();
  const answeredAt = pending.then(
    () => Date.now(),
    () => Date.now()
  );
  const watch = watchForSheet(host.wallet);
  let first: { sheet: SheetView & { seenAt: number } } | { result: T };
  try {
    first = await ctx.deadline.race(
      Promise.race([watch.seen.then(sheet => ({ sheet })), pending.then(result => ({ result }))]),
      'the approval sheet or the answer'
    );
  } finally {
    watch.stop();
  }
  if ('result' in first) {
    ctx.evidence.popupOpened = false;
    if (failedOutcome(first.result)) ctx.evidence.dappError = first.result.error;
    throw new Error(`expected an approval sheet, but the request settled first: ${JSON.stringify(first.result)}`);
  }
  ctx.evidence.popupOpened = true;
  const sheet: SeenSheet = { ...first.sheet, sentAt };
  if (sheet.origin !== host.origin) {
    throw new Error(`the sheet names ${sheet.origin ?? 'no origin'}, expected ${host.origin}; not answering it`);
  }
  if (plan.tickStandingAccess === true) await tickStandingAccess(host.wallet);
  await plan.whileOpen?.(sheet);
  if (plan.decision === 'none') {
    // Nothing is pressed: the wallet declines on its own, which closes the sheet.
    await ctx.deadline.race(
      waitForSheetClosed(host.wallet, ctx.deadline.remainingMs()),
      'the sheet closing on its own'
    );
  } else {
    await pressSheet(host.wallet, plan.decision);
    await waitForSheetClosed(host.wallet, SHEET_CLOSE_MS);
  }
  const result = await answerAfterClose(host, pending, ctx);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, sheet, answeredAt: await answeredAt };
}

/** Starts a request and approves its sheet if the wallet opens one (a connect the wallet may grant silently). */
export async function approveSheetIfShown<T>(
  host: SheetHost,
  start: () => Promise<T>,
  ctx: CellContext
): Promise<{ result: T; prompted: boolean }> {
  await noEarlierSheet(host.wallet);
  const pending = start();
  const watch = watchForSheet(host.wallet);
  let first: { sheet: SheetView & { seenAt: number } } | { result: T };
  try {
    first = await ctx.deadline.race(
      Promise.race([watch.seen.then(sheet => ({ sheet })), pending.then(result => ({ result }))]),
      'the approval sheet or the answer'
    );
  } finally {
    watch.stop();
  }
  if ('result' in first) {
    if (failedOutcome(first.result)) ctx.evidence.dappError = first.result.error;
    return { result: first.result, prompted: false };
  }
  ctx.evidence.popupOpened = true;
  if (first.sheet.origin !== host.origin) {
    throw new Error(`the sheet names ${first.sheet.origin ?? 'no origin'}, expected ${host.origin}; not answering it`);
  }
  await pressSheet(host.wallet, 'approve');
  await waitForSheetClosed(host.wallet, SHEET_CLOSE_MS);
  const result = await answerAfterClose(host, pending, ctx);
  if (failedOutcome(result)) ctx.evidence.dappError = result.error;
  return { result, prompted: true };
}

/**
 * Runs a request that must open no sheet, and fails the moment one opens. With `refusal`, the positive control of spec
 * section 5 also holds: the answer came before the next block the dApp saw.
 */
export async function expectNoSheet<T>(
  host: SheetHost,
  start: () => Promise<T>,
  ctx: CellContext,
  options: { refusal?: boolean } = {}
): Promise<T> {
  await noEarlierSheet(host.wallet);
  const before = options.refusal === true ? (await callOn(host.channel, 'syncHeight', {}, ctx.deadline)).height : 0;
  const watch = watchForSheet(host.wallet);
  let settled: { value: T } | { sheet: SheetView };
  try {
    settled = await ctx.deadline.race(
      Promise.race([start().then(value => ({ value })), watch.seen.then(sheet => ({ sheet }))]),
      'a request that must open no sheet'
    );
  } finally {
    watch.stop();
  }
  if ('sheet' in settled) {
    ctx.evidence.popupOpened = true;
    throw new Error(
      `an approval sheet opened for a request that must not prompt: ${JSON.stringify(settled.sheet.messages)}`
    );
  }
  ctx.evidence.popupOpened = false;
  if (failedOutcome(settled.value)) ctx.evidence.dappError = settled.value.error;
  // Asked once: a repeat lands later and widens the difference.
  const after =
    options.refusal === true ? (await callOn(host.channel, 'syncHeight', {}, ctx.deadline, { once: true })).height : 0;
  expect(after - before, 'blocks the dApp saw while a refusal before enqueue was pending').toBeLessThanOrEqual(1);
  return settled.value;
}
