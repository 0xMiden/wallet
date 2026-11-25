/**
 * Shared helpers of the multi-device suite (`playwright/e2e/tests/multi-device/`).
 *
 * Every read here comes from real product state: the rendered UI, the wallet's
 * own IndexedDB rows, its extension storage, or the E2E-only store and
 * intercom hooks (`window.__TEST_STORE__`, `window.__TEST_INTERCOM__`). No wait
 * here is a bare sleep: each one polls a condition and fails with what it saw.
 *
 * Product rules these helpers follow (repo CLAUDE.md): "Signer identity is
 * membership, never a slot", "One note, several devices" and "Rotated-out hot
 * key". A recovery with the recovery phrase shows the device-role step
 * (`ChooseDeviceRole`) before its rotation: `'add'` appends this device's hot
 * key to the signer set, `'main'` replaces the set with `[newHot, cold]`.
 */
import { expect, type Page } from '@playwright/test';

import { ensureFeeFunded } from './fee-funding';
import type { MidenCli } from './miden-cli';
import { PASSWORD, type DeviceRole, type GuardianAuthInfo, type RecoveryPhrasePromptPolicy } from './wallet-page';
import { isRecord } from '../../../src/lib/update/guards';
import { getEnvironmentConfig } from '../config/environments';
import type { GuardianAwareWalletPage, WalletApiControls } from '../fixtures/multi-device';

// ── Shared account setup ────────────────────────────────────────────────────

export interface SharedAccountOptions {
  /** The device that creates the Guardian account. */
  creator: GuardianAwareWalletPage;
  /** The device that recovers the account with the recovery phrase. */
  joiner: GuardianAwareWalletPage;
  midenCli: MidenCli;
  /** The joiner's answer to the device-role step. */
  role: DeviceRole;
  /** The Guardian operator. Default: the network's first operator (`envConfig.guardianUrl`). */
  guardianUrl?: string;
  /** `true` (default) drives the real recovery screens; `false` uses the onboarding bypass. */
  viaUI?: boolean;
  /** What the joiner does with the "Keep your recovery phrase?" sheet. Default `'keep'`. */
  recoveryPhrasePrompt?: RecoveryPhrasePromptPolicy;
}

export interface SharedAccount {
  /** The account address, the same on both devices. */
  address: string;
  /** The 12-word recovery phrase, space separated. */
  phrase: string;
}

/**
 * Create a Guardian account on `creator`, fund it for fees, wait until the
 * Guardian has made the last pushed state canonical, then recover the same
 * account on `joiner` with `role` and wait until the joiner's rotation landed
 * and the Guardian settled it too.
 *
 * Resolves with both devices on their home surface. With `role: 'add'` the
 * chain then holds 3 signers (two hot keys and the cold key); with `'main'` it
 * holds 2 and the creator is rotated out.
 *
 * Call it before any other Guardian transaction on either wallet: it starts
 * the Guardian commitment tracking of both (`trackGuardianCommitments`).
 */
export async function setupSharedAccount(options: SharedAccountOptions): Promise<SharedAccount> {
  const { creator, joiner, midenCli, role } = options;
  const guardianUrl = options.guardianUrl ?? getEnvironmentConfig().guardianUrl;
  const viaUI = options.viaUI ?? true;
  const recoveryPhrasePrompt = options.recoveryPhrasePrompt ?? 'keep';

  const created = await creator.createGuardianWallet(guardianUrl);
  expect(created.seedPhrase.length, 'the created Guardian account must give a 12-word recovery phrase').toBe(12);
  const phrase = created.seedPhrase.join(' ');

  // The fee funding claim is a Guardian transaction: the ledger must see its push.
  creator.trackGuardianCommitments();
  const funded = await ensureFeeFunded(midenCli, creator, created.address);
  // The Guardian refuses the joiner's rotation proposal while the creator's last delta is
  // still a candidate. A zero-fee chain pushes nothing here, and the settle wait refuses an
  // empty ledger, so it waits only after a real claim.
  if (funded > 0n) await creator.waitForGuardianSettled();

  joiner.trackGuardianCommitments();
  await joiner.recoverGuardianFromSeed(phrase, { viaUI, guardianUrl, role, recoveryPhrasePrompt });
  // The bypass path returns with the rotation in flight; the UI path returns after it landed.
  if (!viaUI) await joiner.completeHotKeyRotation({ role, recoveryPhrasePrompt });

  const joinedAddress = await joiner.getAccountAddress();
  expect(joinedAddress, 'the recovery phrase must restore the SAME account on the joining device').toBe(
    created.address
  );
  // The rotation pushed a delta: the next device or transaction must not meet a pending candidate.
  await joiner.waitForGuardianSettled();
  return { address: created.address, phrase };
}

/**
 * Drive the real recovery screens on a fresh profile up to the device-role step
 * and stop there, with nothing answered. Then the spec reads the step
 * (`readDeviceRoleStep`) and finishes with
 * `wallet.completeHotKeyRotation({ role })`, which answers the step.
 */
export async function recoverToDeviceRoleStep(wallet: GuardianAwareWalletPage, phrase: string): Promise<void> {
  const page = wallet.page;
  await wallet.openImportSeedPhraseScreen();
  const words = phrase.trim().split(/\s+/);
  for (const [index, word] of words.entries()) {
    await page.locator(`#seed-phrase-input-${index}`).fill(word);
  }
  await page.getByTestId('import-seed-submit').click({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(PASSWORD);
  await page.getByTestId('create-password-verify-input').fill(PASSWORD);
  await page.getByTestId('create-password-submit').click({ timeout: 15_000 });
  await page
    .getByTestId('guardian-detected')
    .or(page.getByTestId('guardian-not-detected'))
    .or(page.getByTestId('guardian-no-backup'))
    .or(page.getByTestId('guardian-lookup-uncertain'))
    .first()
    .waitFor({ timeout: 30_000 });
  await page.getByTestId('recovery-method-continue').click({ timeout: 30_000 });
  await page.getByTestId('onboarding-confirmation').waitFor({ timeout: 30_000 });
  await page.getByTestId('onboarding-confirmation-submit').click({ timeout: 15_000 });
  await page.getByTestId('choose-device-role').waitFor({ state: 'visible', timeout: 180_000 });
}

export interface DeviceRoleStepView {
  /** The selected role, or `null` when no option is checked. */
  selected: DeviceRole | null;
  /** The visible text of the step, which carries the device-count line when the count is known. */
  text: string;
}

/** Read the device-role step as the user sees it. Fails when the step is not on screen. */
export async function readDeviceRoleStep(wallet: GuardianAwareWalletPage): Promise<DeviceRoleStepView> {
  const page = wallet.page;
  const step = page.getByTestId('choose-device-role');
  await expect(step, 'the device-role step must be on screen').toBeVisible();
  const checked = async (testId: string): Promise<boolean> =>
    (await page.getByTestId(testId).getAttribute('aria-checked')) === 'true';
  const add = await checked('device-role-add');
  const main = await checked('device-role-main');
  let selected: DeviceRole | null = null;
  if (add) selected = 'add';
  if (main) selected = 'main';
  return { selected, text: (await step.innerText()).trim() };
}

// ── On-chain signer set ─────────────────────────────────────────────────────

export interface SignerSet {
  /** Every signer commitment on chain: the hot key of each device and the cold key. */
  commitments: string[];
  signerCount: number;
  /** The multisig default threshold. */
  threshold: number;
  /** The `update_guardian` procedure threshold (2 for a Guardian account, also after an add). */
  updateGuardianThreshold: number | undefined;
  procedureThresholds: Record<string, number>;
  /** The active Guardian operator's commitment, a separate storage slot. */
  guardianCommitment: string | undefined;
}

const toSignerSet = (address: string, info: GuardianAuthInfo): SignerSet => {
  if (info.error) throw new Error(`readSignerSet(${address}): ${info.error}`);
  return {
    commitments: info.signerCommitments,
    signerCount: info.signerCommitments.length,
    threshold: info.threshold,
    updateGuardianThreshold: info.procedureThresholds.update_guardian,
    procedureThresholds: info.procedureThresholds,
    guardianCommitment: info.guardianCommitment
  };
};

/**
 * The account's signer set as this wallet last read it from chain
 * (`__TEST_GUARDIAN_AUTH__`, which the balance poll keeps current). A read
 * right after a rotation can be one poll old: use `waitForSignerCount` to wait
 * for a change.
 */
export async function readSignerSet(wallet: GuardianAwareWalletPage, address: string): Promise<SignerSet> {
  return toSignerSet(address, await wallet.getGuardianAuthInfo(address));
}

/** Poll the signer set until it holds `count` signers, and return that set. */
export async function waitForSignerCount(
  wallet: GuardianAwareWalletPage,
  address: string,
  count: number,
  timeoutMs = 180_000
): Promise<SignerSet> {
  let last: SignerSet | undefined;
  await expect
    .poll(
      async () => {
        last = await readSignerSet(wallet, address);
        return last.signerCount;
      },
      { message: `signer count of ${address}`, timeout: timeoutMs, intervals: [2_000] }
    )
    .toBe(count);
  if (last === undefined) throw new Error('waitForSignerCount: no read');
  return last;
}

/** Commitments arrive with and without `0x`, in any case, and with leading zeros or not. */
export function sameCommitment(a: string, b: string): boolean {
  const strip = (hex: string): string => hex.trim().toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
  return strip(a) === strip(b);
}

export interface DeviceList {
  /** The signer commitments of the devices, as the Devices page lists them (the recovery key left out). */
  commitments: string[];
  /** The commitment of THIS device's hot key, or `null` when this device is in no signer slot. */
  current: string | null;
}

/**
 * Read the account's devices from Settings > Devices (`DeviceSettings.tsx`).
 * The product finds this device's signer by membership of its hot key's
 * commitment (`findOwnSignerCommitment`) and marks it "This device", so
 * `current` is the truthful answer to "is this device a signer". The page
 * reads under a non-blocking WASM lock and can fail while the client is busy;
 * this presses Refresh until a read lands or `timeoutMs` ends. Returns to home.
 */
export async function readDeviceList(wallet: GuardianAwareWalletPage, timeoutMs = 90_000): Promise<DeviceList> {
  const page = wallet.page;
  await wallet.navigateTo('/settings/devices');
  const settings = page.getByTestId('device-settings');
  await settings.waitFor({ state: 'visible', timeout: 30_000 });
  const rows = page.getByTestId('device-signer-row');
  const failure = settings.getByRole('alert');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await rows
      .first()
      .or(failure.first())
      .waitFor({ state: 'visible', timeout: Math.max(deadline - Date.now(), 1) });
    if ((await rows.count()) > 0) break;
    if (Date.now() >= deadline) throw new Error('readDeviceList: the Devices page never read the device list');
    await page.getByTestId('device-signers-refresh').click();
    // The refresh clears the failure before it reads again.
    await failure.first().waitFor({ state: 'hidden', timeout: 10_000 });
  }
  const commitments: string[] = [];
  let current: string | null = null;
  for (const row of await rows.all()) {
    const commitment = (await row.getByTestId('device-signer-commitment').innerText()).trim();
    commitments.push(commitment);
    if ((await row.getByTestId('device-signer-current').count()) > 0) current = commitment;
  }
  await wallet.navigateHome();
  return { commitments, current };
}

/** True when this device's hot key is a signer of its current account, read from the Devices page. */
export async function isThisDeviceASigner(wallet: GuardianAwareWalletPage): Promise<boolean> {
  return (await readDeviceList(wallet)).current !== null;
}

// ── Gates and prompts ───────────────────────────────────────────────────────

/** Both variants of the rotated-out sheet show Remove; only the one with a recovery key shows Make main. */
const ROTATED_OUT_REMOVE = 'hot-key-rotated-out-remove';
const ROTATED_OUT_MAKE_MAIN = 'hot-key-rotated-out-make-main';
const KEEP_PROMPT_KEEP = 'recovery-phrase-keep-keep';
const KEEP_PROMPT_REMOVE = 'recovery-phrase-keep-remove';
const CONFIRM_DIALOG_CONFIRM = 'confirmation-modal-confirm';

/**
 * Wait until the "This device was revoked" sheet (`HotKeyRotatedOutGate`) shows.
 * The product shows it only after the Guardian sync's self-heal saw a streak of
 * refused requests and judged this device's key out of the signer set, so give
 * it minutes, not seconds.
 */
export async function waitForRotatedOutGate(wallet: GuardianAwareWalletPage, timeoutMs = 600_000): Promise<void> {
  await expect(wallet.page.getByTestId(ROTATED_OUT_REMOVE), 'the rotated-out sheet must show').toBeVisible({
    timeout: timeoutMs
  });
}

/** Assert that the rotated-out sheet is not on screen now. */
export async function expectNoRotatedOutGate(wallet: GuardianAwareWalletPage): Promise<void> {
  await expect(wallet.page.getByTestId(ROTATED_OUT_REMOVE), 'the rotated-out sheet must not show').toHaveCount(0);
}

/** Read the persisted rotated-out verdict of the current account (`WalletAccount.hotKeyRotatedOut`). */
export async function readRotatedOutVerdict(wallet: GuardianAwareWalletPage): Promise<boolean> {
  const account = await readCurrentAccount(wallet.page);
  return account !== null && isRecord(account.hotKeyRotatedOut);
}

/**
 * On the rotated-out sheet, press "Make this device the main one" and confirm.
 * The account then needs a rotation, and the everyday-key gate shows; finish
 * with `wallet.completeHotKeyRotation({ role: 'main' })`.
 */
export async function makeThisDeviceMainFromRotatedOutGate(wallet: GuardianAwareWalletPage): Promise<void> {
  const page = wallet.page;
  await page.getByTestId(ROTATED_OUT_MAKE_MAIN).click();
  await page.getByTestId(CONFIRM_DIALOG_CONFIRM).click();
  await expect(page.getByTestId('hot-key-rotation-gate'), 'the everyday-key gate must take over').toBeVisible({
    timeout: 60_000
  });
}

/**
 * Wait until the "Keep your recovery phrase?" sheet shows. Recover with
 * `recoveryPhrasePrompt: 'leave'`, else the harness answers Keep first.
 */
export async function waitForRecoveryPhraseKeepPrompt(
  wallet: GuardianAwareWalletPage,
  timeoutMs = 300_000
): Promise<void> {
  await expect(wallet.page.getByTestId(KEEP_PROMPT_REMOVE), 'the recovery phrase keep sheet must show').toBeVisible({
    timeout: timeoutMs
  });
}

/** Assert that the keep sheet is not on screen now. */
export async function expectNoRecoveryPhraseKeepPrompt(wallet: GuardianAwareWalletPage): Promise<void> {
  await expect(wallet.page.getByTestId(KEEP_PROMPT_REMOVE), 'the recovery phrase keep sheet must not show').toHaveCount(
    0
  );
}

/**
 * Answer the keep sheet and wait until it closes. `'remove'` removes the
 * stored recovery phrase at once; `readRecoveryPhraseStatus` then reads
 * `removed`. A refused removal keeps the sheet up, so this then fails.
 */
export async function answerRecoveryPhraseKeepPrompt(
  wallet: GuardianAwareWalletPage,
  answer: 'keep' | 'remove'
): Promise<void> {
  const page = wallet.page;
  const testId = answer === 'keep' ? KEEP_PROMPT_KEEP : KEEP_PROMPT_REMOVE;
  await page.getByTestId(testId).click();
  await expect(page.getByTestId(KEEP_PROMPT_REMOVE), 'the keep sheet must close after the answer').toHaveCount(0, {
    timeout: 60_000
  });
}

export type RecoveryPhraseStatus = 'stored' | 'removing' | 'removed' | 'unavailable';

/** The wallet's `seedPhraseStatus` from the store, or `null` before the first state sync. */
export async function readRecoveryPhraseStatus(wallet: GuardianAwareWalletPage): Promise<RecoveryPhraseStatus | null> {
  const state = await readStoreState(wallet.page);
  if (state === null) return null;
  switch (state.seedPhraseStatus) {
    case 'stored':
    case 'removing':
    case 'removed':
    case 'unavailable':
      return state.seedPhraseStatus;
    default:
      return null;
  }
}

// ── Store reads ─────────────────────────────────────────────────────────────

/** The store's whole state as plain JSON, or `null` without the E2E store hook. */
async function readStoreState(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(() => {
    const store: unknown = Reflect.get(globalThis, '__TEST_STORE__');
    if ((typeof store !== 'function' && typeof store !== 'object') || store === null) return null;
    const getState: unknown = Reflect.get(store, 'getState');
    if (typeof getState !== 'function') return null;
    const state: unknown = getState.call(store);
    // Drop functions and turn bigints into strings: only JSON data crosses the evaluate boundary.
    const parsed: unknown = JSON.parse(
      JSON.stringify(state, (_key, value: unknown) => {
        switch (typeof value) {
          case 'function':
            return undefined;
          case 'bigint':
            return value.toString();
          default:
            return value;
        }
      })
    );
    return parsed;
  });
  return isRecord(raw) ? raw : null;
}

/** The store's `currentAccount`, or `null`. */
export async function readCurrentAccount(page: Page): Promise<Record<string, unknown> | null> {
  const state = await readStoreState(page);
  const account = state?.currentAccount;
  return isRecord(account) ? account : null;
}

// ── Encrypted backup ────────────────────────────────────────────────────────

/** `STATE_STORAGE_KEY` in src/lib/backup/state.ts. */
const BACKUP_STATE_STORAGE_KEY = 'backup_state_v1';

export interface BackupStateView {
  /** The sync public key the state belongs to. */
  publicKey: string;
  /** The profile salt (key generation); `null` until the first session opened. */
  salt: string | null;
  profileEtag: string | null;
  /** Chunks of this device's history with a change the server has not acknowledged. */
  dirtyHistoryChunks: number[];
  /** Transaction row ids this device uploaded (assigned to a history chunk). */
  uploadedRowIds: string[];
  /** Per feature: the hashed keys this device last read or wrote. */
  entryCounts: Record<'accounts' | 'contacts' | 'history', number>;
}

const readEntryCount = (features: Record<string, unknown>, feature: string): number => {
  const state = features[feature];
  if (!isRecord(state) || !isRecord(state.entries)) return 0;
  return Object.keys(state.entries).length;
};

/**
 * The local backup state of this device (`backup_state_v1` in extension
 * storage, written by `persistBackupState`), or `null` when no backup session
 * has opened on this device yet.
 */
export async function readBackupState(wallet: GuardianAwareWalletPage): Promise<BackupStateView | null> {
  const raw = (await wallet.dumpChromeStorage())[BACKUP_STATE_STORAGE_KEY];
  if (!isRecord(raw) || typeof raw.publicKey !== 'string') return null;
  const history = isRecord(raw.history) ? raw.history : {};
  const features = isRecord(raw.features) ? raw.features : {};
  const dirty = Array.isArray(history.dirty) ? history.dirty.filter((n): n is number => typeof n === 'number') : [];
  return {
    publicKey: raw.publicKey,
    salt: typeof raw.salt === 'string' ? raw.salt : null,
    profileEtag: typeof raw.profileEtag === 'string' ? raw.profileEtag : null,
    dirtyHistoryChunks: dirty,
    uploadedRowIds: isRecord(history.assigned) ? Object.keys(history.assigned) : [],
    entryCounts: {
      accounts: readEntryCount(features, 'accounts'),
      contacts: readEntryCount(features, 'contacts'),
      history: readEntryCount(features, 'history')
    }
  };
}

/** Why the backup of a device is not settled yet, or `null` when it is. */
export function backupUnsettledReason(state: BackupStateView | null, rows: readonly HistoryRow[]): string | null {
  if (state === null) return 'no backup session has opened on this device';
  if (state.salt === null) return 'the backup profile has no salt yet';
  if (state.dirtyHistoryChunks.length > 0) {
    return `history chunks ${state.dirtyHistoryChunks.join(', ')} wait for the server`;
  }
  const uploaded = new Set(state.uploadedRowIds);
  const missing = rows.filter(row => isUploadableRow(row) && !uploaded.has(row.id)).map(row => row.id);
  if (missing.length > 0) return `terminal rows not uploaded yet: ${missing.join(', ')}`;
  return null;
}

/**
 * Wait until this device's backup is settled: a session opened (the salt is
 * set), no history chunk waits for the server, and every terminal row this
 * device made (`isAppendableRow` in src/lib/backup/features/history.ts) is in
 * an uploaded chunk. This reads the state the backup itself persists after
 * each acknowledged write. It does not start a refresh: the product's own
 * events (unlock, a row reaching a final status) must upload.
 */
export async function waitForBackupSettled(wallet: GuardianAwareWalletPage, timeoutMs = 120_000): Promise<void> {
  let reason: string | null = 'not read yet';
  await expect
    .poll(
      async () => {
        reason = backupUnsettledReason(await readBackupState(wallet), await readHistory(wallet));
        return reason;
      },
      { message: 'backup settled on this device', timeout: timeoutMs, intervals: [2_000] }
    )
    .toBeNull()
    .catch((error: unknown) => {
      throw new Error(`waitForBackupSettled: ${reason ?? 'unknown'} (${error instanceof Error ? error.message : ''})`);
    });
}

export type BackupRefreshReason = 'unlock' | 'foreground' | 'address-book' | 'activity-open' | 'transaction-completed';
export type BackupRefreshOutcome = 'disabled' | 'locked' | 'no-sync-key' | 'failed' | 'unchanged' | 'updated';

const BACKUP_REFRESH_OUTCOMES: readonly BackupRefreshOutcome[] = [
  'disabled',
  'locked',
  'no-sync-key',
  'failed',
  'unchanged',
  'updated'
];

/**
 * Send the backup refresh request the UI sends (`BACKUP_REFRESH_REQUEST`, the
 * same message `useBackupForegroundRefresh` and Activity send) and return
 * the backend's outcome.
 */
export async function requestBackupRefresh(
  wallet: GuardianAwareWalletPage,
  reason: BackupRefreshReason
): Promise<BackupRefreshOutcome> {
  const raw = await wallet.page.evaluate(async refreshReason => {
    const intercom: unknown = Reflect.get(globalThis, '__TEST_INTERCOM__');
    if (typeof intercom !== 'object' || intercom === null) return null;
    const request: unknown = Reflect.get(intercom, 'request');
    if (typeof request !== 'function') return null;
    const response: unknown = await request.call(intercom, { type: 'BACKUP_REFRESH_REQUEST', reason: refreshReason });
    return typeof response === 'object' && response !== null ? Reflect.get(response, 'outcome') : null;
  }, reason);
  const outcome = BACKUP_REFRESH_OUTCOMES.find(known => known === raw);
  if (outcome === undefined) {
    throw new Error(`requestBackupRefresh: no outcome (got ${JSON.stringify(raw)}); is this an E2E build?`);
  }
  return outcome;
}

/**
 * The runtime half of the wallet-api guard. Asks the running extension for a
 * backup refresh and requires both: the backend did not answer `disabled` (the
 * build has a base URL), and the wallet's browser context sent at least one
 * request to the local Worker during the refresh (so the base URL is the
 * Worker's, not the network's configured service). A refresh that reached the
 * Worker and failed (for example a refused origin) fails here too, with its
 * outcome. The wallet must be unlocked with an account.
 */
export async function assertBackupReachesWalletApi(
  wallet: GuardianAwareWalletPage,
  walletApi: WalletApiControls
): Promise<void> {
  const before = walletApi.requestCount(wallet);
  const outcome = await requestBackupRefresh(wallet, 'foreground');
  const sent = walletApi.requestCount(wallet) - before;
  if (outcome === 'disabled') {
    throw new Error(
      'The running extension has no wallet-api base URL (the backup refresh answered "disabled"). ' +
        `Rebuild with "MIDEN_WALLET_API_URL=${walletApi.baseUrl} yarn test:e2e:multi-device:build".`
    );
  }
  if (sent === 0) {
    throw new Error(
      `The backup refresh (outcome "${outcome}") sent no request to ${walletApi.baseUrl}. The build talks to ` +
        'another wallet-api, or this harness does not see service-worker requests through context.route.'
    );
  }
  if (outcome !== 'updated' && outcome !== 'unchanged') {
    throw new Error(
      `The backup refresh reached ${walletApi.baseUrl} (${sent} requests) but ended "${outcome}". ` +
        'Read the service worker console in the timeline: the Worker may refuse this extension origin.'
    );
  }
}

// ── Transaction history ─────────────────────────────────────────────────────

/** `ITransactionStatus` in src/lib/miden/db/types.ts. */
export type HistoryStatus = 'Queued' | 'GeneratingTransaction' | 'Completed' | 'Failed' | 'Unconfirmed';

const STATUS_NAMES: Record<number, HistoryStatus> = {
  0: 'Queued',
  1: 'GeneratingTransaction',
  2: 'Completed',
  3: 'Failed',
  4: 'Unconfirmed'
};

export interface HistoryRow {
  id: string;
  type: string;
  status: HistoryStatus;
  accountId: string | undefined;
  noteIds: string[];
  /** Base units, as a decimal string, when the row has an amount. */
  amount: string | undefined;
  faucetId: string | undefined;
  error: string | undefined;
  /** The row came from another device's backup receipt. */
  restoredFromBackup: boolean;
  /** The row came from Guardian history recovery. */
  recovered: boolean;
  initiatedAt: number | undefined;
}

/** A terminal row this device made: the rows the backup uploads (`isAppendableRow`). */
export function isUploadableRow(row: HistoryRow): boolean {
  switch (row.status) {
    case 'Completed':
    case 'Failed':
    case 'Unconfirmed':
      return !row.restoredFromBackup && !row.recovered;
    default:
      return false;
  }
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function toHistoryRow(raw: unknown): HistoryRow | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'number') return null;
  const status = STATUS_NAMES[raw.status];
  if (status === undefined) return null;
  const noteIds = Array.isArray(raw.noteIds) ? raw.noteIds.filter((id): id is string => typeof id === 'string') : [];
  const noteId = optionalString(raw.noteId);
  if (noteId !== undefined && !noteIds.includes(noteId)) noteIds.push(noteId);
  return {
    id: raw.id,
    type: optionalString(raw.type) ?? '',
    status,
    accountId: optionalString(raw.accountId),
    noteIds,
    amount: optionalString(raw.amount),
    faucetId: optionalString(raw.faucetId),
    error: optionalString(raw.error),
    restoredFromBackup: raw.restoredFromBackup === true,
    recovered: raw.recovered === true,
    initiatedAt: typeof raw.initiatedAt === 'number' ? raw.initiatedAt : undefined
  };
}

/**
 * Every transaction row of this device (the Dexie `TridentMain.transactions`
 * store), oldest first by `initiatedAt`. Rows restored from another device's
 * backup and rows from Guardian history recovery are included and flagged.
 */
export async function readHistory(wallet: GuardianAwareWalletPage): Promise<HistoryRow[]> {
  const raw = await wallet.page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('TridentMain');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      const rows: Record<string, string | number | boolean | string[] | undefined>[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursor = db.transaction('transactions', 'readonly').objectStore('transactions').openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null) {
            resolve();
            return;
          }
          const value: unknown = current.value;
          if (typeof value === 'object' && value !== null) {
            const field = (key: string): unknown => Reflect.get(value, key);
            const amount = field('amount');
            const noteIds = field('noteIds');
            rows.push({
              id: String(field('id')),
              type: typeof field('type') === 'string' ? String(field('type')) : undefined,
              status: typeof field('status') === 'number' ? Number(field('status')) : -1,
              accountId: typeof field('accountId') === 'string' ? String(field('accountId')) : undefined,
              noteId: typeof field('noteId') === 'string' ? String(field('noteId')) : undefined,
              noteIds: Array.isArray(noteIds) ? noteIds.filter(id => typeof id === 'string') : undefined,
              amount:
                typeof amount === 'bigint' || typeof amount === 'number' || typeof amount === 'string'
                  ? String(amount)
                  : undefined,
              faucetId: typeof field('faucetId') === 'string' ? String(field('faucetId')) : undefined,
              error: typeof field('error') === 'string' ? String(field('error')) : undefined,
              restoredFromBackup: field('restoredFromBackup') === true,
              recovered: field('recovered') === true,
              initiatedAt: typeof field('initiatedAt') === 'number' ? Number(field('initiatedAt')) : undefined
            });
          }
          current.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return rows;
    } finally {
      db.close();
    }
  });
  return raw
    .map(toHistoryRow)
    .filter((row): row is HistoryRow => row !== null)
    .sort((a, b) => (a.initiatedAt ?? 0) - (b.initiatedAt ?? 0));
}

/** One line per row, for failure messages. */
export function describeRows(rows: readonly HistoryRow[]): string {
  return rows
    .map(
      row =>
        `[${row.type} ${row.status} ${row.id.slice(0, 8)} notes=${row.noteIds.length}` +
        `${row.restoredFromBackup ? ' restored' : ''}${row.recovered ? ' recovered' : ''}] ${row.error ?? ''}`
    )
    .join('\n  ');
}

/**
 * Assert that this device holds no Failed row, optionally only among rows
 * that `filter` keeps (for example one type, or rows after a time).
 */
export async function expectNoFailedRows(
  wallet: GuardianAwareWalletPage,
  filter: (row: HistoryRow) => boolean = () => true
): Promise<void> {
  const rows = (await readHistory(wallet)).filter(filter);
  const failed = rows.filter(row => row.status === 'Failed');
  expect(failed, `this device must hold no Failed row:\n  ${describeRows(failed)}`).toEqual([]);
}

/** Poll this device's rows until `predicate` matches one, and return that row. */
export async function waitForHistoryRow(
  wallet: GuardianAwareWalletPage,
  predicate: (row: HistoryRow) => boolean,
  description: string,
  timeoutMs = 180_000
): Promise<HistoryRow> {
  let found: HistoryRow | undefined;
  let last: HistoryRow[] = [];
  await expect
    .poll(
      async () => {
        last = await readHistory(wallet);
        found = last.find(predicate);
        return found !== undefined;
      },
      { message: `a row: ${description}`, timeout: timeoutMs, intervals: [2_000] }
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `waitForHistoryRow(${description}): no match. Rows:\n  ${describeRows(last)}\n` +
          `${error instanceof Error ? error.message : ''}`
      );
    });
  if (found === undefined) throw new Error(`waitForHistoryRow(${description}): no match`);
  return found;
}
