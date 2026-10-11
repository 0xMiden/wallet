import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import type { Hash } from 'viem';

import { captureEpochTraffic, fastFeeExpectation, waitForFastQuote } from './epoch-quote';
import { readTransactionRowsWithBytes, type JsonValue, type TransactionRowSnapshot } from './history';
import type { MidenCli } from './miden-cli';
import { swOf } from './swap';
import type { ChromeWalletPageApi } from './wallet-page';
import type { TimelineRecorder } from '../harness/timeline-recorder';

/**
 * Driver for the cross-chain bridge E2E suite (Miden -> EVM, "Fast"/Epoch route).
 *
 * The Fast route needs NO connected EVM wallet: the wallet mints a Miden P2IDE
 * note to the Epoch allocator, and the hosted solver fulfils the EVM leg,
 * delivering USDC to the destination address on Sepolia (see
 * `src/lib/epoch/epoch-send.ts`). So this driver only:
 *   - `fundBridgeToken` — mints a fresh faucet token into the wallet (self-mint,
 *     like the swap suite; the Epoch allocator prices any Miden token).
 *   - `bridgeOutFast` — drives the real Send UI: 0x recipient -> Sepolia network ->
 *     token + amount -> Fast route -> review submit.
 *   - `readBridgedSendRows` — reads the `bridged-send` activity row(s) to assert
 *     the Miden leg completed.
 * The Sepolia-side proof (USDC actually arrived) lives in `./sepolia`.
 */

type Wallet = ChromeWalletPageApi;

export interface FundBridgeTokenOptions {
  /** Faucet/token symbol shown in the send token picker. */
  symbol: string;
  /** Token decimals. 6 keeps `bridgeOutFast('1')` a small ~1-USDC solver fill. */
  decimals?: number;
  /** Base units minted to the wallet (default 1e9 = 1000 tokens @ 6dp). */
  amount?: number;
  /** Balance-wait/claim budget (default 150s). */
  balanceTimeoutMs?: number;
}

export interface FundedBridgeToken {
  symbol: string;
  /** hex faucet id as the CLI reports it. */
  faucetHex: string;
  decimals: number;
}

/**
 * Mint a fresh faucet token into the wallet so it has something to bridge. The
 * wallet must already be created. Mirrors the swap suite's `fundSwapPair`, but
 * single-sided (there is no counterparty — the Epoch solver is).
 */
export async function fundBridgeToken(
  midenCli: MidenCli,
  wallet: Wallet,
  opts: FundBridgeTokenOptions,
  timeline?: TimelineRecorder
): Promise<FundedBridgeToken> {
  const decimals = opts.decimals ?? 6;
  const amount = opts.amount ?? 1_000_000_000;
  const timeout = opts.balanceTimeoutMs ?? 150_000;

  await midenCli.init();
  const faucetHex = await midenCli.createFaucet(opts.symbol, decimals);
  const addr = await wallet.getAccountAddress();
  await midenCli.mint(faucetHex, addr, amount, 'public');
  await midenCli.sync();

  await wallet.waitForBalanceAbove(0, timeout, timeline);
  await wallet.claimAllNotes(timeout);

  return { symbol: opts.symbol, faucetHex, decimals };
}

export interface BridgeOutFastOptions {
  /** EVM (0x) recipient — also the Epoch intent sponsor; no connected wallet needed. */
  destAddress: `0x${string}`;
  /** Symbol of the funded token to bridge (matches `fundBridgeToken`). */
  tokenSymbol: string;
  /** Human amount to bridge, as typed in the UI (e.g. '1'). */
  amount: string;
  /** Per-step timeout (default 30s). */
  stepTimeoutMs?: number;
  /** How long to wait for the live Epoch quote before the route can be confirmed (default 60s). */
  quoteTimeoutMs?: number;
}

/**
 * Drive the real Send flow to bridge a token to a 0x address via the Fast (Epoch)
 * route, ending on the generating-transaction screen. UI-only — every step goes
 * through the same widgets a user taps.
 */
export async function bridgeOutFast(wallet: Wallet, opts: BridgeOutFastOptions): Promise<void> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? 30_000;
  // Record Epoch HTTP from the very start so a quote failure can name the status
  // and body rather than just timing out.
  const epochTraffic = captureEpochTraffic(page);

  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
  await expect(page.getByTestId('send-flow')).toBeVisible({ timeout: step });
  // The home swipe container keeps sibling panes (notably the swap flow) mounted,
  // so shared testids like `send-token-selector` / `send-amount-input` are not
  // unique document-wide. Scope every in-flow interaction to the active send
  // flow; drawers are portaled to the document root and the review is a separate
  // full-screen route, so those stay on `page`.
  const flow = page.getByTestId('send-flow');

  // Recipient: a 0x address flips the flow to cross-chain and reveals the network row.
  await flow.getByTestId('send-recipient-input').fill(opts.destAddress);
  await page.getByTestId('send-network-sepolia').click({ timeout: step });
  await flow.getByTestId('send-recipient-confirm').click({ timeout: step });

  // Amount: pick the funded token, type the amount.
  await flow.getByTestId('send-token-selector').click({ timeout: step });
  await page.getByTestId(`send-token-${opts.tokenSymbol}`).click({ timeout: step });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: step });

  // Route: Fast (Epoch) is the default. Selecting it explicitly guards against a
  // default change. The confirm button is never disabled, so gate on the real
  // signal: the forward quote actually resolving.
  //
  // We assert on the QUOTE STATE, not on the "$" the fee renders. `fastFeeUsd` is
  // undefined for three unrelated reasons — not a bridge route, no token, no quote
  // — and all three paint the same "—", so a text assertion cannot say which
  // happened, and `$0.00` from a missing fiat price would pass it. On failure this
  // reports the hook's own error plus the Epoch HTTP status/body.
  await expect(flow.getByTestId('bridge-route-fast')).toBeVisible({ timeout: step });
  await flow.getByTestId('bridge-route-fast').click();
  const quote = await waitForFastQuote(page, epochTraffic, { timeoutMs: opts.quoteTimeoutMs ?? 60_000 });
  // The fee the user sees must also render - the quote resolving in state while the
  // card still shows "—" is a real (and otherwise invisible) UI regression. An unpriced
  // token is the exception: its fee is not invented, so the card keeps the placeholder.
  const feeCase = fastFeeExpectation(quote.fiatPrice);
  const fastCardText = {
    fee: {
      pattern: /\$/,
      message: `priced token (fiatPrice ${quote.fiatPrice}): quote resolved (${quote.amount} ${quote.symbol}) but the Fast card shows no "$" fee`
    },
    placeholder: {
      pattern: /^[^$]*—[^$]*$/,
      message: `unpriced token (fiatPrice ${quote.fiatPrice ?? 'null'}): the Fast card must show the "—" placeholder and no "$" fee`
    }
  }[feeCase];
  await expect(flow.getByTestId('bridge-route-fast'), fastCardText.message).toHaveText(fastCardText.pattern, {
    timeout: 15_000
  });
  await flow.getByTestId('bridge-route-confirm').click();

  // Review -> submit -> generating-transaction.
  await page.getByTestId('send-review-submit').click({ timeout: step });
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
}

export interface BridgeOutSlowOptions {
  /** EVM (0x) recipient of the bridged asset. */
  destAddress: `0x${string}`;
  /** Symbol of the funded bridgeable token (matches `fundBridgeToken`). */
  tokenSymbol: string;
  /** Human amount to bridge, as typed in the UI (e.g. '1'). */
  amount: string;
  /** Per-step timeout (default 30s). */
  stepTimeoutMs?: number;
}

const STEP_TIMEOUT_MS = 30_000;
// The route step reads the real bridge registry: up to two 15 s RPC attempts.
const REGISTRY_READ_TIMEOUT_MS = 60_000;

/**
 * Drive the real Send flow to the cross-chain route step: 0x recipient -> Sepolia
 * -> token + amount -> confirm. UI-only, like `bridgeOutFast`.
 */
export async function openRouteStep(wallet: Wallet, opts: BridgeOutSlowOptions): Promise<void> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;

  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
  await expect(page.getByTestId('send-flow')).toBeVisible({ timeout: step });

  const flow = page.getByTestId('send-flow');

  // Recipient: a 0x address flips the flow to cross-chain and reveals the network row.
  await flow.getByTestId('send-recipient-input').fill(opts.destAddress);
  await page.getByTestId('send-network-sepolia').click({ timeout: step });
  await flow.getByTestId('send-recipient-confirm').click({ timeout: step });

  // Amount: pick the funded token, type the amount.
  await flow.getByTestId('send-token-selector').click({ timeout: step });
  await page.getByTestId(`send-token-${opts.tokenSymbol}`).click({ timeout: step });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: step });

  await expect(flow.getByTestId('bridge-route-slow')).toBeVisible({ timeout: step });
}

/**
 * On the current route step, the bridge registry refuses the token: Slow is
 * disabled and the notice says so. A registry read that throws shows the
 * check-failed copy instead, which this assertion names.
 */
export async function expectSlowRouteUnsupported(wallet: Wallet): Promise<void> {
  const flow = wallet.page.getByTestId('send-flow');
  await expect(
    flow.getByRole('status'),
    'the registry must refuse this token; "Could not check this token" means the registry read threw'
  ).toHaveText('This token does not support the Slow route.', { timeout: REGISTRY_READ_TIMEOUT_MS });
  await expect(flow.getByTestId('bridge-route-slow')).toBeDisabled();
}

/** Back out of the route step to the amount step, which unmounts SendRoute and its registry answer. */
export async function backToAmountStep(wallet: Wallet): Promise<void> {
  const flow = wallet.page.getByTestId('send-flow');
  await flow.getByTestId('flow-back').filter({ visible: true }).click({ timeout: STEP_TIMEOUT_MS });
  await expect(flow.getByTestId('send-amount-confirm')).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

/** The real registry approves the bridge's own faucet: the one check of the approving branch against a node. */
export async function expectRegistryApproves(page: Page, faucetHex: string): Promise<void> {
  const approved = await page.evaluate(async faucetRef => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_CHECK_AGGLAYER_FAUCET__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_CHECK_AGGLAYER_FAUCET__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    return hook(faucetRef);
  }, faucetHex);
  expect(
    approved,
    'the bridge registry must approve its own faucet; false means the registry key layout or flag index is wrong'
  ).toBe(true);
}

/**
 * Allowlist a runtime-created faucet for the Slow route through the E2E-only
 * page hook. The entry lives in the page's memory: a reload drops it.
 */
export async function allowAgglayerFaucetForE2E(page: Page, faucetHex: string): Promise<void> {
  await page.evaluate(async faucetRef => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_ALLOW_AGGLAYER_FAUCET__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_ALLOW_AGGLAYER_FAUCET__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    await hook(faucetRef);
  }, faucetHex);
}

/** Confirm the amount step, so a fresh route step mounts and checks the registry again. */
export async function confirmAmountStep(wallet: Wallet): Promise<void> {
  const flow = wallet.page.getByTestId('send-flow');
  await flow.getByTestId('send-amount-confirm').click({ timeout: STEP_TIMEOUT_MS });
  await expect(flow.getByTestId('bridge-route-slow')).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

/**
 * On the route step, take Slow and submit through review, ending on the
 * generating-transaction screen. Slow is enabled only for a token the bridge
 * registry lists or one allowlisted with `allowAgglayerFaucetForE2E`.
 */
export async function selectSlowAndSubmit(wallet: Wallet, stepTimeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const { page } = wallet;
  const flow = page.getByTestId('send-flow');

  await expect(flow.getByTestId('bridge-route-slow')).toBeEnabled({ timeout: REGISTRY_READ_TIMEOUT_MS });
  await flow.getByTestId('bridge-route-slow').click();
  await flow.getByTestId('bridge-route-confirm').click({ timeout: stepTimeoutMs });

  // Review -> submit -> generating-transaction.
  await page.getByTestId('send-review-submit').click({ timeout: stepTimeoutMs });
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
}

/**
 * Drive the real Send flow to bridge a token to a 0x address via the Slow
 * (AggLayer) route. Unlike Fast, there is NO live quote: the Slow card shows a
 * fixed "no fee". Slow is enabled for a token the bridge registry lists or one
 * allowlisted with `allowAgglayerFaucetForE2E`; for any other token this fails.
 */
export async function bridgeOutSlow(wallet: Wallet, opts: BridgeOutSlowOptions): Promise<void> {
  await openRouteStep(wallet, opts);
  await selectSlowAndSubmit(wallet, opts.stepTimeoutMs);
}

/** A destination USDC balance a USDCx burn row saved, six-decimal base units and the block it was read at. */
export interface UsdcxBalanceSnapshotRow {
  balance: string;
  blockNumber: string;
}

export interface UsdcxBurnRow {
  noteId: string;
  destinationDomain: number;
  /** 'pending' | 'consuming' | 'confirmed' | 'discarded'. */
  phase: string;
  lastError?: string;
  /** Read before the burn was queued (usdcx/burn.ts). */
  destinationBalanceBefore?: UsdcxBalanceSnapshotRow;
  /** The balance that met the expected payout: the wallet's own destination confirmation. */
  destinationBalanceConfirmed?: UsdcxBalanceSnapshotRow;
  attemptCount?: number;
  lastAttemptBlockNum?: number;
}

export interface BridgedSendExtraInputsRow {
  usdcxBurn?: UsdcxBurnRow;
  /** The 0x recipient. */
  destinationAddress?: string;
  /** The destination's EVM chain id (or the L1 bridge's network id for agglayer). */
  destinationNetwork?: number;
  intentNonce?: string;
  outputAmount?: string;
  evmTxHash?: string;
  /** 'agglayer' (Slow) | 'epoch' (Fast) | 'usdcx'. */
  provider?: string;
  /** AggLayer L1 claim lifecycle: 'pending' | 'ready' | 'claimed'. */
  claimStatus?: string;
  /** AggLayer: the indexer tx_hash of the row's exit, stored when the B2AGG note is built. */
  agglayerExitTxHash?: string;
}

export interface BridgedSendRow {
  /** The Dexie row id, the `:txId` of the generating and history-details routes. */
  id: string;
  /** ITransactionStatus: Queued=0, GeneratingTransaction=1, Completed=2, Failed=3, Unconfirmed=4. */
  status: number;
  stage?: string;
  /** Wall-clock ms of each stage's first entry in the current attempt. */
  stageTimestamps?: Record<string, number>;
  /** User-facing failure reason on a Failed row. */
  error?: string;
  /** The underlying failure, before any friendly rewrite -- the one worth reading. */
  rawError?: string;
  displayMessage?: string;
  transactionId?: string;
  outputNoteIds?: string[];
  /** The request the row was queued with, as plain numbers: `page.evaluate` hands back JSON-safe values only. */
  requestBytes?: number[];
  /** Fee paid, base units as a decimal string; absent on a landed path, which records no fee. */
  feeAmount?: string;
  feeFaucetId?: string;
  completedAt?: number;
  /** The serialized `TransactionResult`, base64. The reaper releases it 10 min after `completedAt`. */
  resultBytes?: string;
  resultReleasedAt?: number;
  submitEvidence?: JsonValue[];
  extraInputs?: BridgedSendExtraInputsRow;
}

export interface SentNoteShape {
  ok: boolean;
  error?: string;
  /** NoteType enum: Private=0, Public=1 (null if unreadable). */
  noteType?: number | null;
  isPublic?: boolean;
  /** The note script's MAST root (hex), for the P2ID/P2IDE discrimination below. */
  scriptRoot?: string;
  isP2id?: boolean;
  isP2ide?: boolean;
}

/**
 * Inspect a committed SENT note's visibility + script kind via the SW hook
 * `__TEST_INSPECT_SENT_NOTE__`. The Epoch bridge collateral note MUST be a
 * PUBLIC recallable P2IDE: the allocator can't read a private note ("not found
 * on-chain") and rejects a plain P2ID for having no recall window. This is the
 * on-chain guard for the guardian bridged-send path (#439).
 *
 * The hook runs a full `mc.syncState()` in the service worker before it reads,
 * so this call is UNBOUNDED by default — under load it can sit behind the WASM
 * lock for as long as a sync takes. Pass `timeoutMs` from any spec whose
 * `test.setTimeout` budget has to account for it: an unbounded call inside a
 * long chain burns the whole budget with nothing saying which step hung.
 */
export async function inspectSentNote(
  wallet: Wallet,
  noteId: string,
  opts: { timeoutMs?: number } = {}
): Promise<SentNoteShape> {
  const inspect = swOf(wallet).evaluate(
    (id: string) =>
      (
        globalThis as unknown as { __TEST_INSPECT_SENT_NOTE__: (n: string) => Promise<SentNoteShape> }
      ).__TEST_INSPECT_SENT_NOTE__(id),
    noteId
  ) as Promise<SentNoteShape>;

  if (opts.timeoutMs === undefined) return inspect;

  const timeoutMs = opts.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspect,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `inspectSentNote(${noteId}) did not answer within ${timeoutMs}ms. The hook syncs the service ` +
                  `worker's WASM client before reading, so this is a stalled/blocked sync, not a missing note.`
              )
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * All `bridged-send` rows in the wallet's Dexie `transactions` store, syncing
 * nothing (a pure read of already-persisted rows). A fresh wallet that has done
 * one bridge has exactly one. The read is history.ts's projection, so the
 * row's bigints and bytes arrive JSON-safe.
 */
export async function readBridgedSendRows(page: Page): Promise<BridgedSendRow[]> {
  return (await readTransactionRowsWithBytes(page, 'bridged-send')).map(bridgedSendRowOf);
}

type JsonObject = { [key: string]: JsonValue };

function objectField(source: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = source?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringField(source: JsonObject | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(source: JsonObject | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

function balanceSnapshotOf(source: JsonObject | undefined): UsdcxBalanceSnapshotRow | undefined {
  const balance = stringField(source, 'balance');
  const blockNumber = stringField(source, 'blockNumber');
  return balance !== undefined && blockNumber !== undefined ? { balance, blockNumber } : undefined;
}

function usdcxBurnOf(source: JsonObject | undefined): UsdcxBurnRow | undefined {
  const noteId = stringField(source, 'noteId');
  const destinationDomain = numberField(source, 'destinationDomain');
  const phase = stringField(source, 'phase');
  if (noteId === undefined || destinationDomain === undefined || phase === undefined) return undefined;
  return {
    noteId,
    destinationDomain,
    phase,
    lastError: stringField(source, 'lastError'),
    destinationBalanceBefore: balanceSnapshotOf(objectField(source, 'destinationBalanceBefore')),
    destinationBalanceConfirmed: balanceSnapshotOf(objectField(source, 'destinationBalanceConfirmed')),
    attemptCount: numberField(source, 'attemptCount'),
    lastAttemptBlockNum: numberField(source, 'lastAttemptBlockNum')
  };
}

/** One projected transaction row as a `BridgedSendRow`, keeping only the `extraInputs` fields the type names. */
export function bridgedSendRowOf(row: TransactionRowSnapshot): BridgedSendRow {
  const extra = row.extraInputs;
  return {
    id: row.id,
    status: row.status ?? -1,
    stage: row.stage,
    stageTimestamps: row.stageTimestamps,
    error: row.error,
    rawError: row.rawError,
    displayMessage: row.displayMessage,
    transactionId: row.transactionId,
    outputNoteIds: row.outputNoteIds,
    requestBytes: row.requestBytes,
    feeAmount: row.feeAmount,
    feeFaucetId: row.feeFaucetId,
    completedAt: row.completedAt,
    resultBytes: row.resultBytes,
    resultReleasedAt: row.resultReleasedAt,
    submitEvidence: row.submitEvidence,
    extraInputs:
      extra === undefined
        ? undefined
        : {
            usdcxBurn: usdcxBurnOf(objectField(extra, 'usdcxBurn')),
            destinationAddress: stringField(extra, 'destinationAddress'),
            destinationNetwork: numberField(extra, 'destinationNetwork'),
            intentNonce: stringField(extra, 'intentNonce'),
            outputAmount: stringField(extra, 'outputAmount'),
            evmTxHash: stringField(extra, 'evmTxHash'),
            provider: stringField(extra, 'provider'),
            claimStatus: stringField(extra, 'claimStatus'),
            agglayerExitTxHash: stringField(extra, 'agglayerExitTxHash')
          }
  };
}

const EN_LOCALE_PATH = path.resolve(__dirname, '../../../public/_locales/en/en.json');
let enMessages: Record<string, unknown> | undefined;

function readEnMessages(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(EN_LOCALE_PATH, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`enText: ${EN_LOCALE_PATH} is not a flat JSON object`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * The English copy of `key` (public/_locales/en/en.json) with each `$name$` replaced by `values[name]`. Throws on a
 * missing key, on a value whose placeholder the copy does not have (an assertion built on it would pass against
 * stale copy), and on a placeholder left unreplaced.
 */
export function enText(key: string, values: Record<string, string> = {}): string {
  enMessages ??= readEnMessages();
  const template = enMessages[key];
  if (typeof template !== 'string') throw new Error(`enText: public/_locales/en/en.json has no "${key}"`);
  let text = template;
  for (const [name, value] of Object.entries(values)) {
    const placeholder = `$${name}$`;
    if (!template.includes(placeholder)) {
      throw new Error(`enText: "${key}" has no ${placeholder}; its English copy is ${JSON.stringify(template)}`);
    }
    text = text.split(placeholder).join(value);
  }
  const unreplaced = /\$[A-Za-z0-9_.]+\$/.exec(text);
  if (unreplaced) throw new Error(`enText: "${key}" still holds ${unreplaced[0]}; pass a value for it`);
  return text;
}

export interface CreateUsdcxBridgeReceiveArgs {
  accountId: string;
  /** Base units, as a decimal string. */
  amount: string;
  faucetId: string;
  sourceChainId: number;
  sourceAddress: string;
  sourceAmount: string;
  sourceSymbol: string;
  evmTxHash: Hash;
}

/**
 * A `usdcx` bridged-receive tracking row through the service worker's `__TEST_CREATE_BRIDGE_RECEIVE__`, which moves it
 * to `delivering` with `evmTxHash` as the deposit screen does. Returns the row id.
 */
export async function createUsdcxBridgeReceive(wallet: Wallet, args: CreateUsdcxBridgeReceiveArgs): Promise<string> {
  const id: unknown = await swOf(wallet).evaluate(async hookArgs => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_CREATE_BRIDGE_RECEIVE__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_CREATE_BRIDGE_RECEIVE__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    return hook({ ...hookArgs, provider: 'usdcx' });
  }, args);
  if (typeof id !== 'string' || id === '') {
    throw new Error(`__TEST_CREATE_BRIDGE_RECEIVE__ returned ${JSON.stringify(id)}, not a row id`);
  }
  return id;
}

export type BridgeReceivePhase = 'submitting' | 'delivering' | 'ready' | 'received' | 'failed';

export type BridgeReceiveStateSnapshot = {
  found: boolean;
  phase?: BridgeReceivePhase;
  displayMessage?: string;
  status?: number;
  amount?: string;
  faucetId?: string;
  evmTxHash?: string;
  error?: string;
  midenNoteId?: string;
  sourceChainId?: number;
  usdcxRemoteRecipient?: string;
  /** Unix seconds the row first reached `ready`. */
  readyAt?: number;
};

function isBridgeReceivePhase(value: unknown): value is BridgeReceivePhase {
  return (
    value === 'submitting' || value === 'delivering' || value === 'ready' || value === 'received' || value === 'failed'
  );
}

/** `__TEST_BRIDGE_RECEIVE_STATE__`'s answer, checked field by field, so a renamed hook field fails here by name. */
export function parseBridgeReceiveState(value: unknown): BridgeReceiveStateSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error(`__TEST_BRIDGE_RECEIVE_STATE__ returned ${JSON.stringify(value)}, not a state object`);
  }
  const field = (key: string): unknown => Reflect.get(value, key);
  const text = (key: string): string | undefined => {
    const item = field(key);
    return typeof item === 'string' ? item : undefined;
  };
  const count = (key: string): number | undefined => {
    const item = field(key);
    return typeof item === 'number' ? item : undefined;
  };
  const found = field('found');
  if (typeof found !== 'boolean') throw new Error('__TEST_BRIDGE_RECEIVE_STATE__ has no boolean found');
  const phase = field('phase');
  if (phase !== undefined && !isBridgeReceivePhase(phase)) {
    throw new Error(`__TEST_BRIDGE_RECEIVE_STATE__ returned an unknown phase ${JSON.stringify(phase)}`);
  }
  return {
    found,
    phase,
    displayMessage: text('displayMessage'),
    status: count('status'),
    amount: text('amount'),
    faucetId: text('faucetId'),
    evmTxHash: text('evmTxHash'),
    error: text('error'),
    midenNoteId: text('midenNoteId'),
    sourceChainId: count('sourceChainId'),
    usdcxRemoteRecipient: text('usdcxRemoteRecipient'),
    readyAt: count('readyAt')
  };
}

/** One bridged-receive row through the service worker's `__TEST_BRIDGE_RECEIVE_STATE__`. */
export async function bridgeReceiveState(wallet: Wallet, txId: string): Promise<BridgeReceiveStateSnapshot> {
  const state: unknown = await swOf(wallet).evaluate(async id => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_BRIDGE_RECEIVE_STATE__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_BRIDGE_RECEIVE_STATE__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    return hook(id);
  }, txId);
  return parseBridgeReceiveState(state);
}
