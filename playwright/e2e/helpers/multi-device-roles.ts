/**
 * Helpers of the "roles" specs of the multi-device suite
 * (`playwright/e2e/tests/multi-device/roles-*.spec.ts`).
 *
 * The shared helpers (`./multi-device.ts`) set up an account and read the
 * signer set, the device list and the gates. This file adds what only the
 * roles specs need: a recovery that stops at the device-role step and answers
 * it by hand, a gate wait that refuses a second role step, the revoke flow of
 * Settings > Devices, the write guard of the product, and a dApp signature.
 *
 * Every read comes from real product state: the rendered UI, the wallet's own
 * IndexedDB rows, its extension storage, or the E2E store hook. No wait here is
 * a bare sleep: each one polls a condition and fails with what it saw.
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { walletDiscoveredNativeFaucetId } from './balance-truth';
import { deadlineIn, type CellContext } from './dapp-cells';
import pinned from './dapp-pinned.json';
import { ensureFeeFunded } from './fee-funding';
import { describeTransactionRow, readTransactionRows, TxStatus, type TransactionRowSnapshot } from './history';
import type { MidenCli } from './miden-cli';
import { readCurrentAccount, sameCommitment, type SharedAccount } from './multi-device';
import { recoverEcdsaPublicKey } from './signature-recovery';
import { answerPrompt, callDapp, expectDomainSignature, openTestDapp, unwrap, type DappInit } from './test-dapp';
import { PASSWORD, type DeviceRole } from './wallet-page';
import {
  isGuardianSyncBlocked,
  isHotKeyRotatedOut,
  type GuardedAccount
} from '../../../src/lib/miden/guardian/sync-guard';
import { isRecord } from '../../../src/lib/update/guards';
import type { GuardianAwareWalletPage } from '../fixtures/multi-device';

// ── Test ids of the product surfaces ────────────────────────────────────────

/** `HotKeyRotationGate.tsx`: the overlay, its failure surface and its funding panel. */
const ROTATION_GATE = 'hot-key-rotation-gate';
const ROTATION_FAILED = 'hot-key-rotation-failed';
const ROTATION_FUNDING = 'hot-key-rotation-funding';
/** `ChooseDeviceRole.tsx`. */
const ROLE_STEP = 'choose-device-role';
const ROLE_CONTINUE = 'device-role-continue';
const ROLE_OPTION: Record<DeviceRole, string> = { add: 'device-role-add', main: 'device-role-main' };
/** `DeviceSettings.tsx`. */
const DEVICE_SETTINGS = 'device-settings';
const DEVICE_ROW = 'device-signer-row';
const DEVICE_COMMITMENT = 'device-signer-commitment';
const DEVICE_REVOKE = 'device-signer-revoke';
const DEVICE_REFRESH = 'device-signers-refresh';
const DEVICE_REVOKE_AUTH = 'device-revoke-auth';
/** `Dialogs.tsx`: the confirm dialog of `useConfirm`. */
const CONFIRM_DIALOG_CONFIRM = 'confirmation-modal-confirm';
const CONFIRM_DIALOG_CANCEL = 'confirmation-modal-cancel';
/** The Remove action of `RecoveryPhraseKeepPrompt.tsx`; both actions show together. */
export const KEEP_PROMPT_SHEET = 'recovery-phrase-keep-remove';
/** The storage key that arms the keep prompt (`RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY`). */
const KEEP_PROMPT_STORAGE_KEY = 'recovery_phrase_keep_prompt';

/** The `#strict-action-password` field of `StrictActionAuthentication.tsx`. */
const STRICT_AUTH_PASSWORD = '#strict-action-password';

/** One poll step of the waits in this file. Each poll reads the product state again. */
const POLL_INTERVALS_MS = [1_000, 2_000];

// ── Account setup ───────────────────────────────────────────────────────────

/**
 * Create a Guardian account on `creator`, fund it for fees, and wait until the
 * Guardian made the funding claim canonical. This is the first half of
 * `setupSharedAccount`, for a spec that drives the joiner itself (stops at the
 * role step, funds after the role step, or leaves the keep prompt to the spec).
 *
 * It starts the Guardian commitment tracking of `creator`.
 */
export async function createFundedGuardianAccount(
  creator: GuardianAwareWalletPage,
  midenCli: MidenCli,
  guardianUrl: string
): Promise<SharedAccount> {
  const created = await creator.createGuardianWallet(guardianUrl);
  expect(created.seedPhrase.length, 'the created Guardian account must give a 12-word recovery phrase').toBe(12);
  creator.trackGuardianCommitments();
  const funded = await ensureFeeFunded(midenCli, creator, created.address);
  // A zero-fee chain pushes nothing, and the settle wait refuses an empty ledger.
  if (funded > 0n) await creator.waitForGuardianSettled();
  return { address: created.address, phrase: created.seedPhrase.join(' ') };
}

/** Read the commitment of a Guardian operator from its own `GET /pubkey?scheme=ecdsa`. */
export async function fetchGuardianCommitment(endpoint: string): Promise<string> {
  const response = await fetch(`${endpoint}/pubkey?scheme=ecdsa`);
  if (!response.ok) {
    throw new Error(`fetchGuardianCommitment: GET ${endpoint}/pubkey?scheme=ecdsa answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.commitment !== 'string') {
    throw new Error(`fetchGuardianCommitment: ${endpoint} sent no commitment`);
  }
  return body.commitment;
}

/** Two Guardian endpoints are the same when they match without case and without a trailing slash. */
export function sameEndpoint(a: string, b: string): boolean {
  const normalize = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

// ── Device-role step ────────────────────────────────────────────────────────

/** Select `role` on the device-role step and check that the option is selected. */
export async function selectDeviceRole(wallet: GuardianAwareWalletPage, role: DeviceRole): Promise<void> {
  const option = wallet.page.getByTestId(ROLE_OPTION[role]);
  await option.click();
  await expect(option, `device role "${role}" must be selected`).toHaveAttribute('aria-checked', 'true');
}

/**
 * Press Continue on the device-role step and wait until the step leaves. The
 * press arms the recovery phrase keep prompt. This does not install the page
 * object's Keep handler, so the spec must answer that prompt itself.
 */
export async function pressDeviceRoleContinue(wallet: GuardianAwareWalletPage): Promise<void> {
  const page = wallet.page;
  await page.getByTestId(ROLE_CONTINUE).click();
  await page.getByTestId(ROLE_STEP).waitFor({ state: 'detached', timeout: 30_000 });
}

/** What the rotation gate showed first after an action that can start a rotation. */
export type RoleStepOrActivation = 'role-step' | 'activation-row';

/**
 * Wait until the device-role step shows, or until a NEW activation row (a
 * `replace-hot-key` row that is not a revocation) exists on this device,
 * whichever comes first. `knownRowIds` are the rows that existed before.
 */
export async function waitForRoleStepOrActivation(
  wallet: GuardianAwareWalletPage,
  knownRowIds: ReadonlySet<string>,
  timeoutMs = 120_000
): Promise<RoleStepOrActivation> {
  // A holder, not a `let`: the poll callback writes it, and a narrowed `let` would hide that write.
  const latest: { seen?: RoleStepOrActivation } = {};
  await expect
    .poll(
      async () => {
        if (await wallet.page.getByTestId(ROLE_STEP).isVisible()) {
          latest.seen = 'role-step';
        } else if (activationRows(await readTransactionRows(wallet.page)).some(row => !knownRowIds.has(row.id))) {
          latest.seen = 'activation-row';
        }
        return latest.seen ?? null;
      },
      { message: 'the device-role step or a new activation row', timeout: timeoutMs, intervals: POLL_INTERVALS_MS }
    )
    .not.toBeNull();
  if (latest.seen === undefined) throw new Error('waitForRoleStepOrActivation: no read');
  return latest.seen;
}

/**
 * Poll until `condition` holds. Fail at once when the device-role step shows
 * on the way: a rotation exists, so the gate must adopt it and never ask again.
 * It reads `wallet.page` again on each poll.
 */
export async function waitWithoutRoleStep(
  wallet: GuardianAwareWalletPage,
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs: number
): Promise<void> {
  const latest: { state: 'waiting' | 'done' | 'role-step' } = { state: 'waiting' };
  await expect
    .poll(
      async () => {
        if (await wallet.page.getByTestId(ROLE_STEP).isVisible()) {
          latest.state = 'role-step';
        } else if (await condition()) {
          latest.state = 'done';
        }
        return latest.state;
      },
      { message: description, timeout: timeoutMs, intervals: POLL_INTERVALS_MS }
    )
    .not.toBe('waiting');
  if (latest.state === 'role-step') {
    throw new Error(`${description}: the device-role step showed again for a rotation that exists`);
  }
}

// ── Rotation gate ───────────────────────────────────────────────────────────

export interface GateClearOptions {
  timeoutMs: number;
  /** Fail when the device-role step shows (the gate must adopt the rotation that exists). */
  failOnRoleStep: boolean;
  /** Test ids that must not show while the gate is up. */
  forbiddenWhileGateUp?: readonly string[];
  /** The funding panel is a failure unless the spec expects it. */
  fundingExpected?: boolean;
}

type GateState = { kind: 'up' } | { kind: 'cleared' } | { kind: 'violation'; reason: string };

async function readGateState(wallet: GuardianAwareWalletPage, options: GateClearOptions): Promise<GateState> {
  const page = wallet.page;
  const account = await readCurrentAccount(page);
  const gateUp = (await page.getByTestId(ROTATION_GATE).count()) > 0;
  // A page that did not load its store yet has no gate either: only a loaded account with the flag clear counts.
  if (!gateUp && account !== null && account.requiresHotKeyRotation !== true) return { kind: 'cleared' };
  if (!gateUp) return { kind: 'up' };
  if (await page.getByTestId(ROTATION_FAILED).isVisible()) {
    return { kind: 'violation', reason: 'the rotation gate reached its failure surface' };
  }
  if (options.failOnRoleStep && (await page.getByTestId(ROLE_STEP).isVisible())) {
    return { kind: 'violation', reason: 'the device-role step showed again for a rotation that exists' };
  }
  if (!options.fundingExpected && (await page.getByTestId(ROTATION_FUNDING).isVisible())) {
    return { kind: 'violation', reason: 'the rotation gate asks for network-fee funding' };
  }
  for (const testId of options.forbiddenWhileGateUp ?? []) {
    if (await page.getByTestId(testId).isVisible()) {
      return { kind: 'violation', reason: `"${testId}" showed while the rotation gate was up` };
    }
  }
  return { kind: 'up' };
}

/**
 * Wait until the rotation gate is gone and the current account no longer needs
 * a rotation. Unlike `completeHotKeyRotation`, this never answers the role step,
 * never answers the keep prompt and never dismisses the telemetry prompt: the
 * spec does those itself. It fails at once on a violation (`GateClearOptions`).
 * It reads `wallet.page` again on each poll, so a `reopen()` before it is safe.
 */
export async function waitForRotationGateCleared(
  wallet: GuardianAwareWalletPage,
  options: GateClearOptions
): Promise<void> {
  const latest: { state: GateState } = { state: { kind: 'up' } };
  await expect
    .poll(
      async () => {
        latest.state = await readGateState(wallet, options);
        return latest.state.kind;
      },
      { message: 'the rotation gate cleared', timeout: options.timeoutMs, intervals: POLL_INTERVALS_MS }
    )
    .not.toBe('up');
  const last = latest.state;
  switch (last.kind) {
    case 'cleared':
      return;
    case 'violation': {
      const rows = await readTransactionRows(wallet.page).catch(() => []);
      throw new Error(
        `waitForRotationGateCleared: ${last.reason}.\n  rows:\n    ${rows.map(describeTransactionRow).join('\n    ')}`
      );
    }
    case 'up':
      throw new Error('waitForRotationGateCleared: the gate is still up');
  }
}

/** The keep prompt's arming key in extension storage: the armed account, or `''` when nothing is armed. */
export async function readKeepPromptArmedFor(wallet: GuardianAwareWalletPage): Promise<string> {
  const value = (await wallet.dumpChromeStorage())[KEEP_PROMPT_STORAGE_KEY];
  return typeof value === 'string' ? value : '';
}

// ── Transaction rows ────────────────────────────────────────────────────────

/** An everyday-key activation row: a `replace-hot-key` row that is not a device revocation (`isActivationRow`). */
export function isActivationRow(row: TransactionRowSnapshot): boolean {
  return row.type === 'replace-hot-key' && revokedCommitmentOf(row) === undefined;
}

export function activationRows(rows: readonly TransactionRowSnapshot[]): TransactionRowSnapshot[] {
  return rows.filter(isActivationRow);
}

/** The device role a row was queued with (`activationModeOf`): a row without a mode is a replace. */
export function activationModeOfRow(row: TransactionRowSnapshot): 'add' | 'replace' {
  switch (row.extraInputs?.mode) {
    case 'add':
      return 'add';
    default:
      return 'replace';
  }
}

/** The signer commitment a revocation row removes, or `undefined` for every other row. */
export function revokedCommitmentOf(row: TransactionRowSnapshot): string | undefined {
  const target = row.extraInputs?.revokedSignerCommitment;
  return typeof target === 'string' ? target : undefined;
}

/** The fee a row paid, in base units. A row with no fee note (a zero-fee chain) paid nothing. */
export function feePaidBy(row: TransactionRowSnapshot): bigint {
  return row.feeAmount === undefined ? 0n : BigInt(row.feeAmount);
}

/** The row's amount in base units. Fails for a row with no amount. */
export function amountOf(row: TransactionRowSnapshot): bigint {
  if (row.amount === undefined) throw new Error(`row ${row.id} (${row.type ?? '?'}) carries no amount`);
  return BigInt(row.amount);
}

/** True for a terminal row: Completed or Failed. Unconfirmed waits for the node's verdict. */
export function isTerminalRow(row: TransactionRowSnapshot): boolean {
  switch (row.status) {
    case TxStatus.Completed:
    case TxStatus.Failed:
      return true;
    default:
      return false;
  }
}

/**
 * Poll this device's rows until one that `predicate` keeps is terminal, and
 * return it. The spec asserts its status, so a Failed row fails with its error.
 */
export async function waitForTerminalRow(
  page: Page,
  predicate: (row: TransactionRowSnapshot) => boolean,
  description: string,
  timeoutMs: number
): Promise<TransactionRowSnapshot> {
  const latest: { matching: TransactionRowSnapshot[]; found?: TransactionRowSnapshot } = { matching: [] };
  await expect
    .poll(
      async () => {
        latest.matching = (await readTransactionRows(page)).filter(predicate);
        latest.found = latest.matching.find(isTerminalRow);
        return latest.found !== undefined;
      },
      { message: `a terminal row: ${description}`, timeout: timeoutMs, intervals: POLL_INTERVALS_MS }
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `waitForTerminalRow(${description}): none is terminal. Matching rows:\n    ` +
          `${latest.matching.map(describeTransactionRow).join('\n    ') || '(none)'}\n` +
          `${error instanceof Error ? error.message : ''}`
      );
    });
  if (latest.found === undefined) throw new Error(`waitForTerminalRow(${description}): no match`);
  return latest.found;
}

/** The row id in a `/generating-transaction[-full]/:txId` URL, or `null`. */
export function generatingTransactionIdOf(url: string): string | null {
  const match = /#\/generating-transaction(?:-full)?\/([^?/#]+)/.exec(url);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

// ── Write guard ─────────────────────────────────────────────────────────────

function guardianSyncStatusOf(value: unknown): GuardedAccount['guardianSyncStatus'] {
  switch (value) {
    case 'in-sync':
    case 'resolving':
    case 'needs-user-input':
      return value;
    default:
      // The product blocks on any set status but 'in-sync', so a value this mirror does not name stays blocked.
      return typeof value === 'string' && value !== '' ? 'resolving' : undefined;
  }
}

function rotatedOutVerdictOf(value: unknown): GuardedAccount['hotKeyRotatedOut'] {
  if (
    !isRecord(value) ||
    typeof value.hotPublicKey !== 'string' ||
    typeof value.onChainHotCommitment !== 'string' ||
    typeof value.detectedAt !== 'number'
  ) {
    return undefined;
  }
  return {
    hotPublicKey: value.hotPublicKey,
    onChainHotCommitment: value.onChainHotCommitment,
    detectedAt: value.detectedAt
  };
}

/** The fields of a store account that the product's write guard reads (`GuardedAccount`). */
export function toGuardedAccount(account: Record<string, unknown>): GuardedAccount {
  return {
    guardianSyncStatus: guardianSyncStatusOf(account.guardianSyncStatus),
    hotPublicKey: typeof account.hotPublicKey === 'string' ? account.hotPublicKey : undefined,
    hotKeyRotatedOut: rotatedOutVerdictOf(account.hotKeyRotatedOut)
  };
}

export interface WriteGuardView {
  /** `isHotKeyRotatedOut`: the persisted verdict names the hot key this device still holds. */
  rotatedOut: boolean;
  /**
   * `isGuardianSyncBlocked`: the predicate behind `assertGuardianInSync`, which
   * fails every Guardian transaction but a guardian switch before its proposal,
   * and behind the dApp projection (`dappGuardianSyncStatus`).
   */
  blocked: boolean;
}

/**
 * Apply the product's own write guard (`lib/miden/guardian/sync-guard.ts`) to
 * the current account as the store holds it. This is the decision every
 * transaction initiator of the device reaches.
 */
export async function readWriteGuard(wallet: GuardianAwareWalletPage): Promise<WriteGuardView> {
  const account = await readCurrentAccount(wallet.page);
  if (account === null) throw new Error('readWriteGuard: the store has no current account');
  const guarded = toGuardedAccount(account);
  return { rotatedOut: isHotKeyRotatedOut(guarded), blocked: isGuardianSyncBlocked(guarded) };
}

// ── Settings > Devices: revoke ──────────────────────────────────────────────

/** Open Settings > Devices and wait until the list read lands, pressing Refresh after a failed read. */
async function openDeviceList(wallet: GuardianAwareWalletPage, timeoutMs = 90_000): Promise<void> {
  const page = wallet.page;
  await wallet.navigateTo('/settings/devices');
  const settings = page.getByTestId(DEVICE_SETTINGS);
  await settings.waitFor({ state: 'visible', timeout: 30_000 });
  const rows = page.getByTestId(DEVICE_ROW);
  const failure = settings.getByRole('alert');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await rows
      .first()
      .or(failure.first())
      .waitFor({ state: 'visible', timeout: Math.max(deadline - Date.now(), 1) });
    if ((await rows.count()) > 0) return;
    if (Date.now() >= deadline) throw new Error('openDeviceList: the Devices page never read the device list');
    await page.getByTestId(DEVICE_REFRESH).click();
    await failure.first().waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

export type RevokeDecision = 'cancel-at-dialog' | 'cancel-at-authentication' | 'confirm';

export type RevokeOutcome = { kind: 'cancelled' } | { kind: 'queued'; rowId: string };

/**
 * On Settings > Devices, press Revoke on the row of `commitment` and answer
 * the flow with `decision`:
 *
 * - `cancel-at-dialog`: Cancel in the confirm dialog.
 * - `cancel-at-authentication`: confirm, then Cancel on the password step.
 * - `confirm`: confirm, type the password, and wait for the in-progress page of
 *   the revocation row (`/generating-transaction-full/:txId`). Returns its id.
 *
 * A cancelled flow ends back on the device list.
 */
export async function revokeDeviceFromSettings(
  wallet: GuardianAwareWalletPage,
  commitment: string,
  decision: RevokeDecision
): Promise<RevokeOutcome> {
  const page = wallet.page;
  await openDeviceList(wallet);
  const rows = await page.getByTestId(DEVICE_ROW).all();
  let target: Locator | undefined;
  for (const row of rows) {
    const shown = (await row.getByTestId(DEVICE_COMMITMENT).innerText()).trim();
    if (sameCommitment(shown, commitment)) target = row;
  }
  if (target === undefined) throw new Error(`revokeDeviceFromSettings: no device row lists ${commitment}`);
  const revoke = target.getByTestId(DEVICE_REVOKE);
  await expect(revoke, 'the Revoke action must be enabled').toBeEnabled();
  await revoke.click();
  await page.getByTestId(CONFIRM_DIALOG_CONFIRM).waitFor({ state: 'visible', timeout: 30_000 });

  switch (decision) {
    case 'cancel-at-dialog':
      await page.getByTestId(CONFIRM_DIALOG_CANCEL).click();
      await page.getByTestId(CONFIRM_DIALOG_CONFIRM).waitFor({ state: 'hidden', timeout: 30_000 });
      await page.getByTestId(DEVICE_SETTINGS).waitFor({ state: 'visible', timeout: 30_000 });
      return { kind: 'cancelled' };
    case 'cancel-at-authentication': {
      await page.getByTestId(CONFIRM_DIALOG_CONFIRM).click();
      const auth = page.getByTestId(DEVICE_REVOKE_AUTH);
      await auth.waitFor({ state: 'visible', timeout: 30_000 });
      // The Cancel button of `StrictActionAuthentication` has no test id; its name is en.json's `cancel`.
      await auth.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByTestId(DEVICE_SETTINGS).waitFor({ state: 'visible', timeout: 30_000 });
      return { kind: 'cancelled' };
    }
    case 'confirm': {
      await page.getByTestId(CONFIRM_DIALOG_CONFIRM).click();
      await page.getByTestId(DEVICE_REVOKE_AUTH).waitFor({ state: 'visible', timeout: 30_000 });
      const password = page.locator(STRICT_AUTH_PASSWORD);
      await password.waitFor({ state: 'visible', timeout: 30_000 });
      await password.fill(PASSWORD);
      await password.press('Enter');
      await page.waitForURL(/#\/generating-transaction(?:-full)?\//, { timeout: 60_000 });
      const rowId = generatingTransactionIdOf(page.url());
      if (rowId === null) throw new Error(`revokeDeviceFromSettings: no row id in ${page.url()}`);
      return { kind: 'queued', rowId };
    }
  }
}

// ── dApp signature ──────────────────────────────────────────────────────────

/**
 * The word the test dApp signs beside its felts. Its first limb is below the
 * field modulus only in little-endian order (as in `dapp/signing-and-refusals.spec.ts`).
 */
const SIGN_WORD = `0xffffffffffffff00${'11'.repeat(24)}`;

export interface DappSignatureEvidence {
  /** The signing commitment the wallet gave the dApp at connect (`ConnectedView.publicKeyHex`). */
  connectCommitment: string;
  /**
   * The commitment of the public key recovered from the signature, as the
   * dApp's SDK computes it. Equal to `connectCommitment` when the signature
   * verifies against the connect key.
   */
  signerCommitment: string;
  /** The signature verifies against the domain commitment of the signed inputs. */
  verifies: boolean;
  schemeTag: number;
}

export interface DappSignatureOptions {
  network: string;
  rpcUrl: string;
  /** A store name of its own, so the dApp opens no store that another test left. */
  storeName: string;
  timeoutMs?: number;
}

/**
 * Open the test dApp beside `wallet`, connect it to the current account, ask
 * for a signature of arbitrary signing inputs (the one request a Guardian
 * account signs, `DAPP_SIGN_RULE`), approve both popups, and check the
 * signature as the existing dApp specs do (`expectDomainSignature`).
 */
export async function signArbitraryInputsFromTestDapp(
  wallet: GuardianAwareWalletPage,
  options: DappSignatureOptions
): Promise<DappSignatureEvidence> {
  await expect
    .poll(() => walletDiscoveredNativeFaucetId(wallet.page), {
      message: 'the wallet discovered its native fee faucet',
      timeout: 60_000,
      intervals: POLL_INTERVALS_MS
    })
    .not.toBeNull();
  const feeFaucetId = await walletDiscoveredNativeFaucetId(wallet.page);
  if (feeFaucetId === null) throw new Error('signArbitraryInputsFromTestDapp: the native fee faucet is not known');
  const init: DappInit = {
    rpcUrl: options.rpcUrl,
    storeName: options.storeName,
    feeFaucetId,
    accountNotFound: pinned.accountNotFound
  };
  const dapp = await openTestDapp(wallet.page.context(), 'one', init);
  try {
    const ctx: CellContext = {
      deadline: deadlineIn(options.timeoutMs ?? 180_000, 'multi-device dApp signature'),
      evidence: {},
      softFail: () => undefined
    };
    const connect = await answerPrompt(
      dapp,
      () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: options.network }, ctx.deadline),
      { kind: 'connect', decision: 'approve', origin: dapp.origin },
      ctx
    );
    const connected = unwrap(connect.result, 'connect', ctx);
    const sign = await answerPrompt(
      dapp,
      () =>
        callDapp(
          dapp,
          'signSigningInputs',
          { variant: 'arbitrary', felts: ['1', '2', '3'], wordHex: SIGN_WORD },
          ctx.deadline
        ),
      { kind: 'sign', decision: 'approve', origin: dapp.origin },
      ctx
    );
    const signed = unwrap(sign.result, 'signBytes(signingInputs, arbitrary)', ctx);
    const verified = await expectDomainSignature(
      input => callDapp(dapp, 'verifySignature', input, ctx.deadline),
      signed,
      'signingInputs',
      recoverEcdsaPublicKey(signed.signatureB64, signed.messageB64)
    );
    return {
      connectCommitment: connected.publicKeyHex,
      signerCommitment: verified.commitmentHex,
      verifies: verified.verifies,
      schemeTag: signed.schemeTag
    };
  } finally {
    await dapp.page.close().catch(() => undefined);
  }
}
