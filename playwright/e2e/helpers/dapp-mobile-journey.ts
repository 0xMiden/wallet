import type { TestInfo } from '@playwright/test';
import path from 'node:path';

import { pollUntil } from './dapp-assertions';
import {
  abortsLeg,
  CellDeadlineExceeded,
  DappCellRunner,
  describeFailure,
  deadlineIn,
  HarnessFault,
  infraAborted,
  InfrastructureFault,
  isInfrastructureFailure,
  type CellContext,
  type CellRecord,
  type CellSpec,
  type Deadline,
  type LegCoverage
} from './dapp-cells';
import { callOn, ChainUnavailable, type DappChannel } from './dapp-channel';
import {
  commandChannel,
  startCommandServer,
  type CommandServer,
  type DeviceKey,
  type PageEvent
} from './dapp-command-server';
import { canonicalAddress, isJourneySender, normalizeHex } from './dapp-gates';
import { ASSETS_AND_NOTES, FUND_A, FUND_B, setupContext, tst } from './dapp-journey';
import { knownBugRegistry } from './dapp-known-bugs';
import { cellIdsFor } from './dapp-matrix';
import type { MobileDappAxis } from './dapp-mobile-axis';
import type { MobileDevice, MobileSurface } from './dapp-mobile-device';
import { answerSheet, denyOpenSheet, type SeenSheet, type SheetHost } from './dapp-mobile-sheet';
import {
  accountRows,
  createAccount,
  foregroundOrigin,
  nativeAsset,
  openDappUrl,
  pendingNotes,
  readRows,
  removeDappSession,
  rowUnits,
  selectAccountIfNeeded,
  waitForQueueDrained,
  type MobileWallet
} from './dapp-mobile-wallet';
import {
  nodeCallProblems,
  nodeHeight,
  summarizeNodeCalls,
  toFetchLog,
  waitForNodeHeight,
  type FetchLogEntry
} from './dapp-node-calls';
import pinned from './dapp-pinned.json';
import type { MidenCli } from './miden-cli';
import { beforeMobileDeadline, type MobileNativeAsset } from './mobile-store-reads';
import { TOKEN } from './money-path';
import { publicFaucetAccountId, publicFaucetApiUrl } from './public-faucet';
import { unwrap, type DappInit } from './test-dapp';
import { DAPP_PORT, type DappLabel } from './test-dapp-server';
import type { TestStepRunner } from '../harness/test-step';
import type { EnvironmentConfig } from '../harness/types';
import type { ConnectedView, DappCommandName, DappInput, DappOutput } from '../test-dapp/protocol';

/**
 * Journey glue for the mobile legs (spec section 3): both wallets, the page on both devices, and each cell run with
 * the quiesce and restore of spec section 5. A spec file calls `startMobileJourney` and `runMobileJourneyCells`.
 */

/** The mobile provider rejects any request after 300 s (injection-script.ts:104-110); every budget stays under 280 s. */
export const MOBILE_PROVIDER_TIMEOUT_MS = 300_000;
export const MOBILE_CELL_BUDGET_MS = { read: 120_000, write: 270_000, long: 180_000 };
export const MOBILE_QUIESCE_BUDGET_MS = 270_000;
/** dapp.ts AUTODECLINE_AFTER: every mobile sheet declines itself this long after the wallet took the request (#1474). */
export const AUTO_DECLINE_MS = 120_000;
/** A held sheet is answered at least this long before the auto-decline (spike plan change 5). */
export const HOLD_MARGIN_MS = 10_000;
/** Public TST notes A holds and never claims: W4 consumes one, R7-consume leaves the other's sheet unanswered. */
export const HELD_W4 = tst(7.25);
export const HELD_R7 = tst(2.5);
/** The private note B's dApp makes for A, which N3a imports as a full NoteFile. */
export const PRODUCED = tst(3.5);

const OUT_DIR = path.resolve(__dirname, '../../../test-results/dapp-cells');
const PAGES_DIR = path.resolve(__dirname, '../../../test-results/dapp-pages');
// The workflow names the part a leg runs, so records from two parts never share a file.
const PART = process.env.DAPP_E2E_PART ?? 'manual';
const PAGE_BOOT_MS = 60_000;
const PAGE_READY_MS = 120_000;
const INIT_MS = 150_000;
/** The presentation script bounds its own request at 30 s (presentation-script.ts request()). */
const PRESENTATION_MS = 35_000;
const FUND_CLAIM_MS = 240_000;
const FUND_SETTLE_MS = 120_000;
const RECIPIENT_SETTLE_MS = 60_000;
const RECIPIENT_JOIN_MARGIN_MS = 1_000;
const RESTORE_STEP_MS = 30_000;
/** Cells after which A's Guardian account may still be settling with its operator. */
const WRITES_A = new Set(['W1', 'W4', 'X1', 'R5']);

export type MobileSlot = 'primary' | 'second';
export type MobileSession = 'none' | 'upon-request' | 'auto';
/** What the quiesce establishes; unset fields take the primary account and an UponRequest session on dApp one. */
export interface MobileCellState {
  account: MobileSlot;
  session: MobileSession;
}
export type MobileCellImpl = Omit<CellSpec<Partial<MobileCellState>>, 'id'>;
export interface MobileDapp extends SheetHost {
  /** `<device>/<dApp>`, as the channel names it. */
  readonly label: string;
  readonly wallet: MobileWallet;
}
export interface HeldNote {
  noteId: string;
  amount: bigint;
}
export interface ProducedNote {
  noteId: string;
  bytesB64: string;
  nullifierHex: string;
  amount: bigint;
}

export interface MobileJourney {
  readonly surface: MobileSurface;
  readonly axis: MobileDappAxis;
  readonly walletA: MobileWallet;
  readonly walletB: MobileWallet;
  /** A raw claim can outlive its cell's race; the next quiesce joins it before driving B. */
  recipientClaim?: { cellId: string; promise: Promise<void> };
  readonly env: EnvironmentConfig;
  readonly network: string;
  readonly runner: DappCellRunner<Partial<MobileCellState>>;
  readonly server: CommandServer;
  /** dApp one beside wallet A, the page every cell drives. */
  readonly dapp: MobileDapp;
  /** dApp one beside wallet B, connected to B, the producer of N3a's note. */
  readonly dappB: MobileDapp;
  /** The CLI faucet as the CLI names it (hex); iOS claims take it to give the notes metadata. */
  readonly cliFaucetId: string;
  /** The wallet's id for the CLI faucet, the form the page and the provider both take. */
  readonly tokenFaucetId: string;
  readonly native: MobileNativeAsset;
  readonly addressB: string;
  readonly held: { readonly w4: HeldNote; readonly r7: HeldNote };
  readonly produced: ProducedNote;
  /** Whether `window.midenWallet` was there when dApp one booted (S1's late injection). */
  readonly providerAtBoot: boolean;
  /** Values one cell leaves for a later one, by name. */
  readonly memo: Map<string, string>;
  /** Every expected or observed journey output, including setup's produced and held notes. */
  readonly outputNoteIds: Set<string>;
  /** Everyone the journey may receive a note from: A's accounts, B, the CLI faucet, the public faucet. */
  senders(): readonly string[];
  account(slot: MobileSlot, deadline?: Deadline): Promise<string>;
  /** `callOn` over dApp one's channel. */
  call<K extends DappCommandName>(
    command: K,
    input: DappInput<K>,
    deadline?: Deadline,
    options?: { once?: boolean }
  ): Promise<DappOutput<K>>;
}

export interface MobileJourneyInput {
  surface: MobileSurface;
  axis: MobileDappAxis;
  walletA: MobileWallet;
  walletB: MobileWallet;
  midenCli: MidenCli;
  envConfig: EnvironmentConfig;
  steps: TestStepRunner;
  testInfo: TestInfo;
  device: MobileDevice;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const contextFor = (deadline: Deadline): CellContext => ({ deadline, evidence: {}, softFail: () => undefined });
const sameAs = (address: string | null, account: string): boolean =>
  address !== null && canonicalAddress(address) === canonicalAddress(account);

function callerOf(channel: DappChannel): MobileJourney['call'] {
  return <K extends DappCommandName>(
    command: K,
    input: DappInput<K>,
    deadline?: Deadline,
    options?: { once?: boolean }
  ) => callOn(channel, command, input, deadline, options);
}

/** How long a sheet sent at `sentAt` may still be held before the hold margin of the auto-decline. */
export const holdLeftMs = (sentAt: number, now: number): number => sentAt + AUTO_DECLINE_MS - HOLD_MARGIN_MS - now;

/** One block passes with the sheet open (the extension's popupBlock), read from the node by the driver (spec 3.3). */
export async function sheetBlock(rpcUrl: string, sheet: SeenSheet, ctx: CellContext): Promise<void> {
  const cutoff = Math.min(Date.now() + ctx.deadline.remainingMs(), sheet.sentAt + AUTO_DECLINE_MS - HOLD_MARGIN_MS);
  if (holdLeftMs(sheet.sentAt, Date.now()) <= 0) {
    throw new HarnessFault(
      `the sheet's hold margin ran out before its block: it was sent ${Date.now() - sheet.sentAt} ms ago`
    );
  }
  const query = async (read: (ms: number) => Promise<number>, what: string): Promise<number> => {
    const expired = (): ChainUnavailable =>
      new ChainUnavailable(`${ctx.deadline.label}: ${what} exceeded the sheet block cutoff`);
    const remaining = cutoff - Date.now();
    if (remaining <= 0) throw expired();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired()), remaining);
      });
      const height = await ctx.deadline.race(Promise.race([read(remaining), timeout]), what);
      if (Date.now() >= cutoff) throw expired();
      return height;
    } catch (error) {
      if (error instanceof CellDeadlineExceeded) throw expired();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const tip = await query(ms => nodeHeight(rpcUrl, ms), 'the node tip with the sheet open');
  await query(ms => waitForNodeHeight(rpcUrl, tip + 1, ms), 'the next block with the sheet open');
}

/** The leg's coverage label from dApp one's presentation event (C-R16). */
export function coverageOf(event: PageEvent | null): LegCoverage | undefined {
  if (event === null) return undefined;
  const reported = event.data.path;
  const detail = event.data.detail;
  return {
    presentationPath: reported === 'gated' || reported === 'fallback' || reported === 'absent' ? reported : 'other',
    detail: typeof detail === 'string' ? detail : JSON.stringify(event.data)
  };
}

/** Keeps the account id a connect handed out, by address, for the Guardian settle of a later quiesce. */
export function remember(j: Pick<MobileJourney, 'memo'>, connected: ConnectedView): void {
  j.memo.set(`accountIdHex:${canonicalAddress(connected.address)}`, connected.accountIdHex);
}

/** Mints `amount` TST to `address`, claims it in `wallet`, and returns the wallet's id for the faucet once it holds it. */
async function fundOne(
  cli: MidenCli,
  wallet: MobileWallet,
  address: string,
  faucetId: string,
  amount: bigint
): Promise<string> {
  await cli.mint(faucetId, address, amount, 'public');
  await cli.sync();
  await wallet.claimAllNotes(FUND_CLAIM_MS, [faucetId]);
  const until = Date.now() + FUND_SETTLE_MS;
  for (;;) {
    const row = (await accountRows(wallet)).rows.find(entry => entry.symbol === TOKEN);
    if (row !== undefined && rowUnits(row) === amount) return row.tokenId;
    if (Date.now() > until) {
      throw new Error(
        `${address} holds ${row === undefined ? 'no' : rowUnits(row).toString()} ${TOKEN} after the claim, expected ${amount}`
      );
    }
    await sleep(3_000);
  }
}

/** Waits for in-flight node calls before judging setup, within both the pending-call and page setup budgets. */
export async function guardNodeCalls(
  channel: DappChannel,
  rpcUrl: string,
  setupDeadline: Deadline,
  options: { pendingWaitMs?: number; now?: () => number } = {}
): Promise<void> {
  const deadline = deadlineIn(
    Math.min(30_000, options.pendingWaitMs ?? 30_000, setupDeadline.remainingMs()),
    'setup node calls',
    options.now ?? Date.now
  );
  const read = async (): Promise<FetchLogEntry[]> =>
    toFetchLog(
      await beforeMobileDeadline(deadline, 'read the page fetch log', () =>
        channel.send('__fetchLog', {}, deadline.remainingMs())
      )
    );
  const origin = new URL(rpcUrl).origin;
  const nodeCalls = (log: FetchLogEntry[]): FetchLogEntry[] => log.filter(call => call.url.startsWith(`${origin}/`));
  let log = await read();
  let calls = nodeCalls(log);
  while (calls.some(call => call.completedAt === null) && deadline.remainingMs() > 0) {
    try {
      await deadline.race(
        sleep(Math.max(1, Math.min(250, deadline.remainingMs() / 2))),
        'wait for in-flight node calls'
      );
      if (deadline.remainingMs() <= 0) break;
      log = await read();
      calls = nodeCalls(log);
    } catch (error) {
      if (!(error instanceof CellDeadlineExceeded)) throw error;
      break;
    }
  }
  const failed = (call: FetchLogEntry): boolean => call.error !== null || (call.status !== null && call.status >= 400);
  const nodeFailed = (call: FetchLogEntry): boolean =>
    !(call.error !== null && /cors|cross[- ]origin|preflight|malformed|invalid (?:request|url)/i.test(call.error)) &&
    (call.completedAt === null ||
      call.error !== null ||
      (call.status !== null && (call.status >= 500 || call.status === 408 || call.status === 429)));
  const problems = nodeCallProblems({
    ...summarizeNodeCalls(log, rpcUrl),
    failed: calls.filter(call => failed(call) && !nodeFailed(call))
  });
  if (problems.length > 0)
    throw new HarnessFault(`the page's node calls would fail every cell: ${problems.join('; ')}`);
  const unrecovered = calls.filter(
    call =>
      nodeFailed(call) &&
      !calls.some(
        next =>
          call.bodyDigest !== null &&
          next.bodyDigest === call.bodyDigest &&
          call.completedAt !== null &&
          next.completedAt !== null &&
          next.completedAt > call.completedAt &&
          next.at > call.completedAt &&
          next.url === call.url &&
          next.method === call.method &&
          next.error === null &&
          next.status !== null &&
          next.status >= 200 &&
          next.status < 400
      )
  );
  if (unrecovered.length > 0) {
    throw new ChainUnavailable(
      `the page's node calls failed: ${unrecovered
        .map(call =>
          call.completedAt === null
            ? `${call.method} ${call.url} still pending`
            : `${call.method} ${call.url} ${call.error ?? `answered ${String(call.status)}`}`
        )
        .join('; ')}`
    );
  }
}

async function openMobileDapp(
  server: CommandServer,
  wallet: MobileWallet,
  device: DeviceKey,
  label: DappLabel,
  init: DappInit
): Promise<{ dapp: MobileDapp; providerAtBoot: boolean; setupDeadline: Deadline }> {
  const url = server.urlFor(device, label);
  const origin = new URL(url).origin;
  const key = `${device}/${label}`;
  await openDappUrl(wallet, url);
  const boot = await server
    .waitForEvent(`${key} boot`, event => event.key === key && event.kind === 'boot', PAGE_BOOT_MS)
    .catch(() => {
      throw new HarnessFault(`${url} never booted on device ${device}`);
    });
  if (boot.data.isSecureContext !== true || boot.data.origin !== origin) {
    throw new HarnessFault(`${url} booted as ${JSON.stringify(boot.data)}, not as a secure context at ${origin}`);
  }
  const provider = await server
    .waitForEvent(`${key} provider`, event => event.key === key && event.kind === 'provider', PAGE_READY_MS)
    .catch(() => {
      throw new Error(`${origin} on device ${device}: window.midenWallet never appeared within ${PAGE_READY_MS} ms`);
    });
  await server
    .waitForEvent(`${key} ready`, event => event.key === key && event.kind === 'ready', PAGE_READY_MS)
    .catch(() => {
      throw new HarnessFault(`${origin} on device ${device}: window.testDapp never became ready`);
    });
  const dapp: MobileDapp = { label: key, origin, wallet, channel: commandChannel(server, device, label) };
  const setupDeadline = deadlineIn(INIT_MS, `dApp ${key} setup`);
  await callOn(dapp.channel, 'init', init, setupDeadline);
  return { dapp, providerAtBoot: provider.data.atBoot === true, setupDeadline };
}

/**
 * B's dApp builds a private note for A and submits it with no recipient, so the wallet relays nothing and A never
 * receives it; B's waitForTransaction hands back its bytes, as a dApp backend would hold them (dapp-writes.ts
 * produceNotesFromB). It waits for the note on chain, because N3a's file carries its inclusion proof.
 */
async function produceNoteForA(
  dappB: MobileDapp,
  recipient: string,
  tokenFaucetId: string,
  ctx: CellContext
): Promise<ProducedNote> {
  const built = await callOn(
    dappB.channel,
    'buildCustom',
    {
      shape: 'p2id',
      outputs: [
        { recipientAddress: recipient, faucetId: tokenFaucetId, amount: PRODUCED.toString(), noteType: 'private' }
      ]
    },
    ctx.deadline
  );
  const { result } = await answerSheet(
    dappB,
    () =>
      callOn(
        dappB.channel,
        'submitCustom',
        { requestId: built.requestId, recipientAddress: '', importNotes: false },
        ctx.deadline
      ),
    { decision: 'approve' },
    ctx
  );
  const { txId } = unwrap(result, "B's producer request", ctx);
  const written = unwrap(
    await callOn(dappB.channel, 'waitForTransaction', { txId }, ctx.deadline),
    "B's producer write",
    ctx
  );
  const noteId = built.outputNoteIds[0] ?? '';
  const out = written.outputNotes.find(note => normalizeHex(note.noteId) === normalizeHex(noteId));
  if (out === undefined) throw new HarnessFault(`B's waitForTransaction did not return note ${noteId}`);
  await pollUntil(
    () => callOn(dappB.channel, 'chainNote', { noteId }, ctx.deadline),
    note => note.found,
    `note ${noteId} on chain`,
    ctx,
    { bounded: true }
  );
  const facts = await callOn(dappB.channel, 'noteFacts', { noteBytesB64: out.bytesB64 }, ctx.deadline);
  return { noteId, bytesB64: out.bytesB64, nullifierHex: facts.nullifierHex, amount: PRODUCED };
}

/**
 * Creates A on the axis and B single-sig, funds both from the CLI faucet, mints A's held notes, opens dApp one on both
 * devices, labels the leg's coverage, guards the page's node calls, connects B's dApp and produces N3a's note. Every
 * declared cell is written `not-run` first; a setup failure the environment caused blocks them as infrastructure.
 */
export async function startMobileJourney(input: MobileJourneyInput): Promise<MobileJourney> {
  const { surface, axis, walletA, walletB, midenCli, envConfig, steps, testInfo, device } = input;
  // Live networks only (the merge-only ruling): fee grants come from the network's public faucet.
  const faucetApi = publicFaucetApiUrl(envConfig.name);
  if (faucetApi === undefined) {
    throw new HarnessFault(
      `the dApp suite runs on testnet or devnet; E2E_NETWORK=${envConfig.name} has no public faucet`
    );
  }
  const holder: { journey?: MobileJourney } = {};
  const current = (): MobileJourney => {
    if (holder.journey === undefined) throw new HarnessFault('journey hooks ran before the journey started');
    return holder.journey;
  };
  const runner = new DappCellRunner<Partial<MobileCellState>>({
    surface,
    part: PART,
    axis: axis.label,
    journey: 'PL',
    testTitle: testInfo.title,
    outDir: OUT_DIR,
    declared: cellIdsFor('PL', axis.label),
    registry: knownBugRegistry,
    hooks: {
      quiesce: (cell, deadline, previous) => quiesce(current(), cell, deadline, previous),
      restore: cell => restore(current(), cell)
    },
    budgets: MOBILE_CELL_BUDGET_MS,
    quiesceBudgetMs: MOBILE_QUIESCE_BUDGET_MS
  });
  const aborted = infraAborted(OUT_DIR);
  if (aborted !== null) {
    runner.blockAll(aborted);
    throw new InfrastructureFault(`an earlier journey hit an infrastructure failure: ${aborted}`);
  }

  let server: CommandServer | undefined;
  try {
    let primary = '';
    let addressB = '';
    await steps.step('create_wallets', async () => {
      primary = (await axis.create(walletA)).address;
      addressB = (await walletB.createNewWallet()).address;
      await device.afterCreate();
    });
    let cliFaucetId = '';
    let tokenFaucetId = '';
    await steps.step('fund_wallets', async () => {
      await midenCli.init();
      cliFaucetId = await midenCli.createFaucet();
      tokenFaucetId = await fundOne(midenCli, walletA, primary, cliFaucetId, FUND_A);
      await fundOne(midenCli, walletB, addressB, cliFaucetId, FUND_B);
    });
    const held = { w4: { noteId: '', amount: HELD_W4 }, r7: { noteId: '', amount: HELD_R7 } };
    await steps.step('mint_held_notes', async () => {
      // Mobile auto-consume takes only the native asset, so these TST notes stay A's until a cell consumes one.
      held.w4.noteId = (await midenCli.mint(cliFaucetId, primary, HELD_W4, 'public')).noteId;
      held.r7.noteId = (await midenCli.mint(cliFaucetId, primary, HELD_R7, 'public')).noteId;
      await midenCli.sync();
    });
    const native = await nativeAsset(walletA, 60_000);
    const started = await startCommandServer({
      port: DAPP_PORT,
      logFile: path.join(PAGES_DIR, `${surface}-${axis.label}.jsonl`)
    });
    server = started;
    const init = (label: string): DappInit => ({
      rpcUrl: envConfig.rpcUrl,
      // Per test, device and origin, so no test opens a store another left notes in.
      storeName: `test-dapp-PL-${surface}-${axis.label}-${label}-${testInfo.testId}`,
      accountNotFound: pinned.accountNotFound
    });
    let opened: { dapp: MobileDapp; providerAtBoot: boolean } | undefined;
    let dappB: MobileDapp | undefined;
    await steps.step('open_dapps', async () => {
      let forwarded: string;
      try {
        forwarded = await device.forwardPagePort(started.port);
      } catch (error) {
        if (error instanceof HarnessFault || error instanceof InfrastructureFault) throw error;
        throw new InfrastructureFault(`dApp page forwarding failed: ${describeFailure(error)}`, { cause: error });
      }
      // eslint-disable-next-line no-console
      console.log(`[dapp ${surface}] page port: ${forwarded}`);
      const one = await openMobileDapp(started, walletA, 'A', 'one', init('A-one'));
      opened = one;
      runner.recordCoverage(
        coverageOf(
          await started
            .waitForEvent(
              'A/one presentation',
              event => event.key === 'A/one' && event.kind === 'presentation',
              PRESENTATION_MS
            )
            .catch(() => null)
        )
      );
      await guardNodeCalls(one.dapp.channel, envConfig.rpcUrl, one.setupDeadline);
      const b = (await openMobileDapp(started, walletB, 'B', 'one', init('B-one'))).dapp;
      const ctx = setupContext(180_000, "B's dApp connect");
      const { result } = await answerSheet(
        b,
        () => callOn(b.channel, 'connect', { permission: 'UponRequest', network: envConfig.name }, ctx.deadline),
        { decision: 'approve' },
        ctx
      );
      unwrap(result, "B's dApp connect", ctx);
      dappB = b;
    });
    if (opened === undefined || dappB === undefined) throw new HarnessFault('the dApps did not open');
    const producer = dappB;
    let produced: ProducedNote | undefined;
    await steps.step('produce_private_note', async () => {
      produced = await produceNoteForA(
        producer,
        primary,
        tokenFaucetId,
        setupContext(8 * 60_000, "B's producer write")
      );
    });
    if (produced === undefined) throw new HarnessFault('no private note for N3a');
    const publicFaucetId = await publicFaucetAccountId(faucetApi);

    const accounts = new Map<MobileSlot, string>([['primary', primary]]);
    const journey: MobileJourney = {
      surface,
      axis,
      walletA,
      walletB,
      env: envConfig,
      network: envConfig.name,
      runner,
      server: started,
      dapp: opened.dapp,
      dappB: producer,
      cliFaucetId,
      tokenFaucetId,
      native,
      addressB,
      held,
      produced,
      providerAtBoot: opened.providerAtBoot,
      memo: new Map(),
      outputNoteIds: new Set([produced.noteId, held.w4.noteId, held.r7.noteId].map(normalizeHex)),
      senders: () => [...accounts.values(), addressB, cliFaucetId, tokenFaucetId, publicFaucetId],
      account: async (slot, deadline) => {
        const known = accounts.get(slot);
        if (known !== undefined) return known;
        const create = (): Promise<string> => createAccount(walletA, axis.walletType);
        const created =
          deadline === undefined ? await create() : await beforeMobileDeadline(deadline, 'account creation', create);
        accounts.set(slot, created);
        // Account creation can also be requested outside a cell; its primary-account restore still needs a bound.
        const selectionDeadline = deadline ?? deadlineIn(RESTORE_STEP_MS, 'primary account selection after creation');
        await beforeMobileDeadline(selectionDeadline, 'primary account selection after creation', () =>
          selectAccountIfNeeded(walletA, primary, selectionDeadline)
        );
        return created;
      },
      call: callerOf(opened.dapp.channel)
    };
    holder.journey = journey;
    return journey;
  } catch (error) {
    // A public-faucet failure anywhere in the funding is the environment's; a wallet claim failure is not, and leaves
    // the cells not-run for the judge.
    runner.setupFailed(error);
    await server?.stop();
    throw error;
  }
}

/** Brings the wallet and dApp one to the state a cell declares, then checks it (spec section 5, "Quiesce"). */
async function quiesce(
  j: MobileJourney,
  cell: CellSpec<Partial<MobileCellState>>,
  deadline: Deadline,
  previous?: CellRecord
): Promise<void> {
  const claim = j.recipientClaim;
  if (claim !== undefined) {
    // Keep the named join failure ahead of the runner's outer quiesce timeout.
    const joinDeadline = deadlineIn(Math.max(0, deadline.remainingMs() - RECIPIENT_JOIN_MARGIN_MS), deadline.label);
    await beforeMobileDeadline(joinDeadline, "wallet B's previous claim", () =>
      claim.promise.catch((error: unknown) => {
        j.runner.recordRecipientClaimFailure(claim.cellId, error);
        // eslint-disable-next-line no-console
        console.warn(`[dapp ${j.surface}] late recipient claim from ${claim.cellId}: ${describeFailure(error)}`);
      })
    );
    j.recipientClaim = undefined;
  }
  const state: MobileCellState = { account: 'primary', session: 'upon-request', ...cell.state };
  await beforeMobileDeadline(deadline, 'sheet denial', () => denyOpenSheet(j.walletA));
  const front = await beforeMobileDeadline(deadline, 'foreground origin', () => foregroundOrigin(j.walletA));
  if (front !== j.dapp.origin)
    throw new Error(`the dApp browser shows ${front ?? 'no page'} in front, not ${j.dapp.origin}`);
  const account = await beforeMobileDeadline(deadline, 'journey account', () => j.account(state.account, deadline));
  await beforeMobileDeadline(deadline, 'account selection', () => selectAccountIfNeeded(j.walletA, account, deadline));
  // One queue serves every origin (`getDappQueue`, actions.ts:109-113); a round trip through it proves no sheet waits.
  await beforeMobileDeadline(deadline, 'request queue round trip', () =>
    j.call('raw', { call: 'requestGuardianInfo', args: [] }, deadline)
  );
  // A write that outlived its cell (a W1 at its ceiling, an R5 row still generating) ends before the next baseline.
  await beforeMobileDeadline(deadline, "wallet A's queue drained", () =>
    waitForQueueDrained(
      () => beforeMobileDeadline(deadline, "wallet A's transaction rows", () => readRows(j.walletA)),
      deadline.remainingMs()
    )
  );
  if (previous !== undefined && WRITES_A.has(previous.id)) await settlePrimary(j, deadline);
  if (previous !== undefined) await quiesceRecipient(j, cell.id, previous, deadline);
  await establishSession(j, account, state.session, deadline);
}

async function settlePrimary(j: MobileJourney, deadline: Deadline): Promise<void> {
  const primary = await beforeMobileDeadline(deadline, 'primary account', () => j.account('primary', deadline));
  const accountIdHex = j.memo.get(`accountIdHex:${canonicalAddress(primary)}`);
  if (accountIdHex === undefined) return;
  const chain = await beforeMobileDeadline(deadline, 'primary account on chain', () =>
    j.call('chainAccount', { accountId: accountIdHex }, deadline)
  );
  await beforeMobileDeadline(deadline, 'primary account settlement', () =>
    j.axis.settle(j.walletA, primary, chain.found ? (chain.commitmentHex ?? null) : null, deadline)
  );
}

/**
 * Journey outputs must have been claimed by their write. Foreign transfers can arrive after a clean receipt; keep
 * their provenance in the record without claiming them or accepting an unexplained journey payment.
 */
async function quiesceRecipient(
  j: MobileJourney,
  cellId: string,
  previous: CellRecord,
  deadline: Deadline
): Promise<void> {
  const pending = await beforeMobileDeadline(deadline, "wallet B's Pending list", () =>
    pendingNotes(
      j.walletB,
      j.addressB,
      j.env.rpcUrl,
      j.network,
      Math.min(RECIPIENT_SETTLE_MS, deadline.remainingMs()),
      deadline
    )
  );
  const known = (noteId: string): boolean => j.outputNoteIds.has(normalizeHex(noteId));
  const owned = pending.filter(note => known(note.noteId) || isJourneySender(note.sender, j.senders()));
  const foreign = pending.filter(note => !owned.includes(note));
  j.runner.recordForeignPendingNotes(cellId, foreign);
  if (owned.length > 0) {
    const outputs = owned.map(note => ({
      ...note,
      accounting: known(note.noteId) ? 'still-pending output' : 'unaccounted journey output'
    }));
    throw new Error(`wallet B has pending journey notes after ${previous.id}: ${JSON.stringify(outputs)}`);
  }
}

async function establishSession(
  j: MobileJourney,
  account: string,
  wanted: MobileSession,
  deadline: Deadline
): Promise<void> {
  const view = await beforeMobileDeadline(deadline, 'session view', () => j.call('session', {}, deadline));
  const permission = wanted === 'auto' ? 'AUTO' : 'UPON_REQUEST';
  const held =
    view.connected !== null &&
    view.adapterConnected &&
    sameAs(view.adapterAddress, account) &&
    sameAs(view.providerAddress, account) &&
    view.connected.privateDataPermission === permission;
  if (wanted !== 'none' && held) return;
  // From nothing: the adapter disconnects and the wallet forgets the origin, so the connect below must prompt.
  await beforeMobileDeadline(deadline, 'session disconnect', () => j.call('disconnect', {}, deadline));
  await beforeMobileDeadline(deadline, 'session revocation', () => removeDappSession(j.walletA, j.dapp.origin));
  if (wanted === 'none') return;
  const ctx = contextFor(deadline);
  const { result } = await beforeMobileDeadline(deadline, 'session connect sheet', () =>
    answerSheet(
      j.dapp,
      () =>
        beforeMobileDeadline(deadline, 'session connect request', () =>
          j.call(
            'connect',
            {
              permission: wanted === 'auto' ? 'Auto' : 'UponRequest',
              network: j.network,
              ...(wanted === 'auto' ? { allowedPrivateData: ASSETS_AND_NOTES } : {})
            },
            deadline
          )
        ),
      { decision: 'approve', tickStandingAccess: wanted === 'auto' },
      ctx
    )
  );
  const connected = unwrap(result, 'quiesce connect', ctx);
  if (!sameAs(connected.address, account))
    throw new Error(`quiesce connected ${connected.address}, expected ${account}`);
  if (connected.privateDataPermission !== permission) {
    throw new HarnessFault(
      `quiesce connect returned privateDataPermission ${connected.privateDataPermission}, expected ${permission}`
    );
  }
  remember(j, connected);
}

/** Always runs after a cell (spec section 5, "Restore"). */
async function restore(j: MobileJourney, cell: CellSpec<Partial<MobileCellState>>): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (what: string, start: (deadline: Deadline) => Promise<unknown>): Promise<void> => {
    const deadline = deadlineIn(RESTORE_STEP_MS, `${cell.id} restore ${what}`);
    try {
      await beforeMobileDeadline(deadline, what, () => start(deadline));
    } catch (error) {
      errors.push(new Error(`${what}: ${describeFailure(error)}`, { cause: error }));
    }
  };
  await attempt('sheet denial', () => denyOpenSheet(j.walletA));
  if (cell.id.startsWith('R7-')) {
    await attempt('disconnect', deadline => j.call('disconnect', {}, deadline));
    await attempt('revocation', () => removeDappSession(j.walletA, j.dapp.origin));
  }
  await attempt('primary account selection', async deadline => {
    const primary = await beforeMobileDeadline(deadline, 'primary account', () => j.account('primary', deadline));
    await beforeMobileDeadline(deadline, 'account selection', () =>
      selectAccountIfNeeded(j.walletA, primary, deadline)
    );
  });
  if (errors.length === 0) return;
  const message = `${cell.id} restore failed: ${errors.map(error => error.message).join('; ')}`;
  const infrastructure = errors.find(abortsLeg) ?? errors.find(isInfrastructureFailure);
  const harness = errors.find(error => error.cause instanceof HarnessFault);
  const collected = new AggregateError(errors, message, { cause: infrastructure ?? harness });
  if (infrastructure !== undefined) {
    throw new InfrastructureFault(message, { cause: collected, abortsLeg: abortsLeg(infrastructure) });
  }
  if (harness !== undefined) {
    const fault = new HarnessFault(message);
    fault.cause = collected;
    throw fault;
  }
  throw collected;
}

/** Runs the journey's declared cells in order, then fails the test with every cell that did not pass. */
export async function runMobileJourneyCells(
  j: MobileJourney,
  impls: Readonly<Record<string, MobileCellImpl>>
): Promise<void> {
  try {
    for (const id of cellIdsFor('PL', j.axis.label)) {
      const impl = impls[id];
      if (impl === undefined) throw new HarnessFault(`journey PL declares ${id} but has no implementation`);
      await j.runner.run({ id, ...impl });
    }
  } finally {
    await j.server.stop();
  }
  j.runner.finish();
}
