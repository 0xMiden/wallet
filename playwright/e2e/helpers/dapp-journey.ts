import type { TestInfo } from '@playwright/test';
import path from 'node:path';

import {
  listVaultAssets,
  walletDiscoveredNativeFaucetId,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from './balance-truth';
import { offchainDappAxis, type DappAxis } from './dapp-axis';
import {
  DappCellRunner,
  HarnessFault,
  InfrastructureFault,
  deadlineIn,
  infraAborted,
  ranClean,
  type CellContext,
  type CellRecord,
  type CellSpec,
  type Deadline,
  type JourneyId
} from './dapp-cells';
import { canonicalAddress } from './dapp-gates';
import { knownBugRegistry } from './dapp-known-bugs';
import { cellIdsFor } from './dapp-matrix';
import pinned from './dapp-pinned.json';
import { readTransactionRows, releaseQueueBlocker } from './history';
import type { MidenCli } from './miden-cli';
import { fundAndClaim, TOKEN, TOKEN_DECIMALS } from './money-path';
import { publicFaucetApiUrl } from './public-faucet';
import {
  answerPrompt,
  callDapp,
  closeOpenConfirmPages,
  ensureUnlocked,
  openTestDapp,
  pendingNoteIds,
  recordConfirmPages,
  revokeDappSession,
  selectAccountIfNeeded,
  setAutoConsume,
  unwrap,
  type ConfirmLog,
  type DappHandle,
  type DappInit
} from './test-dapp';
import type { DappLabel } from './test-dapp-server';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { TestStepRunner } from '../harness/test-step';
import type { EnvironmentConfig } from '../harness/types';

/**
 * Journey glue: funds both wallets, opens the dApp beside wallet A, and runs a journey's cells through the cell runner
 * with the quiesce and restore of spec section 5. A spec file declares its cells and calls `startJourney` and
 * `runJourneyCells`, nothing else.
 */

export type SessionState = 'none' | 'upon-request' | 'auto';
export type AccountSlot = 'primary' | 'second' | 'third';
/** What the quiesce establishes before a cell; unset fields take the primary account, an UponRequest session, dApp one. */
export interface DappCellState {
  account: AccountSlot;
  session: SessionState;
  dapp: DappLabel;
}
export type DappCell = CellSpec<Partial<DappCellState>>;
export type DappCellImpl = Omit<DappCell, 'id'>;
/** A wallet setting a cell changed, put back by the restore after it. */
export type TouchedSetting = 'faults' | 'delegate' | 'autoConsume' | 'spendingLimit';

export const UNIT = 10n ** BigInt(TOKEN_DECIMALS);
/** TST amounts in base units, from whole tokens with at most two decimals. */
export const tst = (units: number): bigint => (BigInt(Math.round(units * 100)) * UNIT) / 100n;
export const FUND_A = tst(1_000);
export const FUND_B = tst(1_000);
/** AllowedPrivateData.Assets | Notes (adapter-base types.d.ts). */
export const ASSETS_AND_NOTES = 3;

const OUT_DIR = path.resolve(__dirname, '../../../test-results/dapp-cells');
// The workflow names the part a leg runs, so records from two parts never share a file.
const PART = process.env.DAPP_E2E_PART ?? 'manual';

export interface Journey {
  readonly id: JourneyId;
  readonly axis: DappAxis;
  readonly walletA: GuardianAwareWalletPage;
  readonly walletB: GuardianAwareWalletPage;
  readonly midenCli: MidenCli;
  readonly env: EnvironmentConfig;
  readonly network: string;
  readonly runner: DappCellRunner<Partial<DappCellState>>;
  readonly dapp: DappHandle;
  readonly confirmLog: ConfirmLog;
  readonly cliFaucetId: string;
  readonly tokenFaucetId: string;
  readonly nativeFaucetId: string;
  readonly addressB: string;
  /** Values one cell leaves for a later one (a note id, a tx id), by name. */
  readonly memo: Map<string, string>;
  readonly init: (label: string) => DappInit;
  /** The address in wallet A for a slot; `second` and `third` are created on first use. */
  account(slot: AccountSlot): Promise<string>;
  dappTwo(): Promise<DappHandle>;
  /** The dApp beside wallet B, connected to B's account. */
  dappB(): Promise<DappHandle>;
  touch(setting: TouchedSetting): void;
}

export interface StartJourneyInput {
  journey: JourneyId;
  axis: DappAxis;
  walletA: GuardianAwareWalletPage;
  walletB: GuardianAwareWalletPage;
  midenCli: MidenCli;
  envConfig: EnvironmentConfig;
  steps: TestStepRunner;
  testInfo: TestInfo;
}

const quiesceContext = (deadline: Deadline): CellContext => ({ deadline, evidence: {}, softFail: () => undefined });

async function waitFor<T>(read: () => Promise<T | null>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Creates and funds A (on the journey's axis) and B (single-sig), opens dApp one beside A, and writes every declared
 * cell as `not-run`. A funding failure that names the public faucet writes INFRA_ABORT, so later journeys record
 * `blocked (infrastructure)` without spending another grant; a node that fails the dApp's init blocks this journey's
 * cells alone (`DappCellRunner.setupFailed`).
 */
export async function startJourney(input: StartJourneyInput): Promise<Journey> {
  const { journey, axis, walletA, walletB, midenCli, envConfig, steps, testInfo } = input;
  // Live networks only (the merge-only ruling): every grant comes from the network's public faucet, which a local
  // chain lacks.
  if (publicFaucetApiUrl(envConfig.name) === undefined) {
    throw new HarnessFault(
      `the dApp suite runs on testnet or devnet; E2E_NETWORK=${envConfig.name} has no public faucet`
    );
  }
  const accounts = new Map<AccountSlot, string>();
  const touched = new Set<TouchedSetting>();
  // The runner's hooks need the journey, which exists only once the runner does.
  const holder: { journey?: Journey } = {};
  const current = (): Journey => {
    if (holder.journey === undefined) throw new HarnessFault('journey hooks ran before the journey started');
    return holder.journey;
  };
  const runner = new DappCellRunner<Partial<DappCellState>>({
    part: PART,
    axis: axis.label,
    journey,
    testTitle: testInfo.title,
    outDir: OUT_DIR,
    declared: cellIdsFor(journey, axis.label),
    registry: knownBugRegistry,
    hooks: {
      quiesce: (cell, deadline, previous) => quiesce(current(), cell, deadline, previous),
      restore: () => restore(current(), touched)
    }
  });
  const aborted = infraAborted(OUT_DIR);
  if (aborted !== null) {
    runner.blockAll(aborted);
    throw new InfrastructureFault(`an earlier journey hit an infrastructure failure: ${aborted}`);
  }

  let funded: { a: string; b: string; cliFaucetId: string };
  try {
    axis.prepare(walletA);
    const a = await axis.create(walletA);
    const b = await offchainDappAxis.create(walletB);
    // fundAndClaim records its own steps (deploy_and_fund, claim_funding_note).
    const cliFaucetId = await fundAndClaim(walletA, midenCli, steps, {
      address: a.address,
      mintBaseUnits: FUND_A,
      discoveryMs: 180_000,
      claimMs: 180_000,
      vaultSettleMs: 180_000
    });
    await steps.step('fund_wallet_b', async () => {
      await midenCli.mint(cliFaucetId, b.address, FUND_B, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletB.page, TOKEN, FUND_B, { timeoutMs: 180_000, decimals: TOKEN_DECIMALS });
      await walletB.claimAllNotes(180_000);
      await waitForVaultBalance(walletB.page, TOKEN, FUND_B, { timeoutMs: 180_000, decimals: TOKEN_DECIMALS });
    });
    funded = { a: a.address, b: b.address, cliFaucetId };
  } catch (error) {
    // A public-faucet failure anywhere in the funding is the environment's (spec section 6); a wallet claim failure
    // is not, and leaves the cells not-run for the judge.
    runner.setupFailed(error);
    throw error;
  }
  accounts.set('primary', funded.a);

  // The wallet's own id for the CLI faucet, the form the page and the provider both take.
  const tokenFaucetId = (await listVaultAssets(walletA.page)).find(asset => asset.symbol === TOKEN)?.tokenId;
  if (tokenFaucetId === undefined) throw new HarnessFault(`wallet A lists no ${TOKEN} row after funding`);
  // The dApp's client must name the fee faucet (spec section 2.2); the wallet caches it once a sync discovered it.
  const nativeFaucetId = await waitFor(
    () => walletDiscoveredNativeFaucetId(walletA.page),
    'native faucet discovered',
    60_000
  );
  const init = (label: string): DappInit => ({
    rpcUrl: envConfig.rpcUrl,
    // Per test and origin, so no test opens a store another test left notes in (spec section 6, Flake controls).
    storeName: `test-dapp-${journey}-${axis.label}-${label}-${testInfo.testId}`,
    feeFaucetId: nativeFaucetId,
    accountNotFound: pinned.accountNotFound
  });
  const contextA = walletA.page.context();
  // Started before the first request, so the log covers every popup of the journey.
  const confirmLog = recordConfirmPages(contextA);
  let dapp: DappHandle;
  try {
    dapp = await openTestDapp(contextA, 'one', init('A-one'));
  } catch (error) {
    runner.setupFailed(error);
    throw error;
  }
  let two: Promise<DappHandle> | undefined;
  let ofB: Promise<DappHandle> | undefined;
  const network = envConfig.name;

  const journeyValue: Journey = {
    id: journey,
    axis,
    walletA,
    walletB,
    midenCli,
    env: envConfig,
    network,
    runner,
    dapp,
    confirmLog,
    cliFaucetId: funded.cliFaucetId,
    tokenFaucetId,
    nativeFaucetId,
    addressB: funded.b,
    memo: new Map(),
    init,
    account: async slot => {
      const known = accounts.get(slot);
      if (known !== undefined) return known;
      // `third` is a single-sig account on either leg (M8 switches between kinds in one wallet).
      const created = await walletA.createAdditionalAccount(slot === 'third' ? 'off-chain' : axis.walletType);
      accounts.set(slot, created.address);
      await selectAccountIfNeeded(walletA, funded.a);
      return created.address;
    },
    dappTwo: () => (two ??= openTestDapp(contextA, 'two', init('A-two'))),
    dappB: () =>
      (ofB ??= (async () => {
        const contextB = walletB.page.context();
        const handle = await openTestDapp(contextB, 'one', init('B-one'));
        const ctx = quiesceContext(deadlineIn(120_000, "B's dApp connect"));
        const { result } = await answerPrompt(
          handle,
          () => callDapp(handle, 'connect', { permission: 'UponRequest', network }),
          { kind: 'connect', decision: 'approve', origin: handle.origin },
          ctx
        );
        unwrap(result, "B's dApp connect", ctx);
        return handle;
      })()),
    touch: setting => void touched.add(setting)
  };
  holder.journey = journeyValue;
  return journeyValue;
}

/** Brings the wallet and the dApp to the state a cell declares, then checks it (spec section 5, "Quiesce"). */
async function quiesce(j: Journey, cell: DappCell, deadline: Deadline, previous?: CellRecord): Promise<void> {
  const state: DappCellState = { account: 'primary', session: 'upon-request', dapp: 'one', ...cell.state };
  await ensureUnlocked(j.walletA);
  await closeOpenConfirmPages(j.walletA.page.context());
  const account = await j.account(state.account);
  await selectAccountIfNeeded(j.walletA, account);
  const dapp = state.dapp === 'two' ? await j.dappTwo() : j.dapp;
  // One queue serves every origin (actions.ts:98-102); a round trip through it proves nothing waits on a popup.
  await callDapp(dapp, 'raw', { call: 'requestGuardianInfo', args: [] }, deadline);
  const blockers = (await readTransactionRows(j.walletA.page)).filter(row => row.id.startsWith('e2e-queue-blocker-'));
  if (blockers.length > 0) throw new Error(`queue blocker rows left behind: ${blockers.map(row => row.id).join(', ')}`);
  await j.walletA.waitForQueueDrained(deadline.remainingMs());
  // After the drain: the settle ledger is complete only once nothing is left to push (guardian-commitments.ts:141-143).
  await j.axis.settle(j.walletA);
  const pendingAtB = await pendingNoteIds(j.walletB.page);
  // A cell that ran clean claimed every note it sent B (expectReceivedByRecipient), so a note still pending after one
  // is a payment no write accounted for, such as a second payment that landed late. It blocks the journey instead of
  // being claimed; after any other outcome the cell's own unclaimed notes are claimed.
  if (pendingAtB.length > 0 && ranClean(previous)) {
    throw new Error(
      `wallet B holds notes no write accounted for after ${previous?.id} passed: ${pendingAtB.join(', ')}`
    );
  }
  if (pendingAtB.length > 0) await j.walletB.claimAllNotes(deadline.remainingMs());
  const leftB = await pendingNoteIds(j.walletB.page);
  if (leftB.length > 0) throw new Error(`wallet B still holds pending notes: ${leftB.join(', ')}`);
  await establishSession(j, dapp, account, state.session, deadline);
}

async function establishSession(
  j: Journey,
  dapp: DappHandle,
  account: string,
  wanted: SessionState,
  deadline: Deadline
): Promise<void> {
  const view = await callDapp(dapp, 'session', {}, deadline);
  const sameAccount = (address: string | null) =>
    address !== null && canonicalAddress(address) === canonicalAddress(account);
  const permission = wanted === 'auto' ? 'AUTO' : 'UPON_REQUEST';
  const already =
    wanted !== 'none' &&
    view.adapterConnected &&
    sameAccount(view.adapterAddress) &&
    sameAccount(view.providerAddress) &&
    view.connected?.privateDataPermission === permission;
  if (already) return;
  // From nothing: the adapter disconnects and the wallet forgets the origin, so the connect below must prompt.
  await callDapp(dapp, 'disconnect', {}, deadline);
  await revokeDappSession(j.walletA, dapp.origin);
  if (wanted === 'none') return;
  const ctx = quiesceContext(deadline);
  const { result } = await answerPrompt(
    dapp,
    () =>
      callDapp(
        dapp,
        'connect',
        {
          permission: wanted === 'auto' ? 'Auto' : 'UponRequest',
          network: j.network,
          ...(wanted === 'auto' ? { allowedPrivateData: ASSETS_AND_NOTES } : {})
        },
        deadline
      ),
    { kind: 'connect', decision: 'approve', origin: dapp.origin, tickPrivateData: wanted === 'auto' },
    ctx
  );
  const connected = unwrap(result, 'quiesce connect', ctx);
  if (!sameAccount(connected.address)) {
    throw new Error(`quiesce connected ${connected.address}, expected ${account}`);
  }
}

/** Always runs after a cell (spec section 5, "Restore"). */
async function restore(j: Journey, touched: Set<TouchedSetting>): Promise<void> {
  await closeOpenConfirmPages(j.walletA.page.context());
  for (const row of (await readTransactionRows(j.walletA.page)).filter(entry =>
    entry.id.startsWith('e2e-queue-blocker-')
  )) {
    await releaseQueueBlocker(j.walletA.page, row.id);
  }
  await ensureUnlocked(j.walletA);
  for (const setting of touched) {
    if (setting === 'faults') await j.walletA.clearFaults();
    if (setting === 'delegate') await j.walletA.setDelegateProofEnabled(true);
    if (setting === 'autoConsume') await setAutoConsume(j.walletA, true);
    if (setting === 'spendingLimit') {
      await selectAccountIfNeeded(j.walletA, await j.account('primary'));
      // With no limit given, the account's limit is deleted (src/lib/miden/spending-limits/config.ts:70-72).
      await j.walletA.configureSpendingLimitForTest({ tokenSymbol: TOKEN });
    }
  }
  touched.clear();
  await selectAccountIfNeeded(j.walletA, await j.account('primary'));
}

/** Runs the journey's declared cells in order, then fails the test with every cell that did not pass. */
export async function runJourneyCells(j: Journey, impls: Readonly<Record<string, DappCellImpl>>): Promise<void> {
  for (const id of cellIdsFor(j.id, j.axis.label)) {
    const impl = impls[id];
    if (impl === undefined) throw new HarnessFault(`journey ${j.id} declares ${id} but its spec has no implementation`);
    await j.runner.run({ id, ...impl });
  }
  j.confirmLog.stop();
  j.runner.finish();
}
