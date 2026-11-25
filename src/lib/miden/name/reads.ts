/**
 * Read-only Miden Name chain reads.
 *
 * Every read uses a bare `RpcClient`. It does not use the WASM client, so it
 * does not take the WASM client lock. Every RPC call goes through
 * `withRpcTimeout`. Every wasm argument (Word, SlotAndKeys, NoteTag, NoteId,
 * AccountStorageRequirements, AccountId) is made INSIDE the retried closure,
 * because the call moves it into Rust and a second attempt with the same
 * object gets a dead handle.
 *
 * Do NOT call `getAccountDetails` on the registry: the node refuses it because
 * the registry maps are too large. Use `getAccountProof` with the keys you need.
 */

import {
  AccountId,
  AccountStorageRequirements,
  Endpoint,
  NoteId,
  NoteTag,
  RpcClient,
  SlotAndKeys,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { walletAccountIdToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import {
  MIDEN_NAME_COMMITMENT_VERSION,
  MIDEN_NAME_FEE_ENTRY_MARKER,
  MIDEN_NAME_ISSUED_MARKER,
  MIDEN_NAME_REGISTER_SCRIPT_ROOT,
  MIDEN_NAME_SLOTS,
  type MidenNameConfig,
  getMidenNameConfig
} from './config';
import { type Felts4, encodeDomainFelts, priceKeyFelts } from './encoding';
import { MidenNameAbortedError, MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import { feltsFromWord, idPartsFromHex, nfasCarryLabel, statusKeyFeltsForLabel, wordFromFelts } from './sdk-words';

const ZERO_FELTS: Felts4 = [0n, 0n, 0n, 0n];
const QUOTE_CACHE_TTL_MS = 30_000;

/** Upper limit of `syncNotes` rounds in one delivery scan. */
const MAX_DELIVERY_SCAN_ROUNDS = 200;

export interface MidenNameQuote {
  label: string;
  /** True when `asset_status` felt 0 is 0 (no one has the name) and the length is priced. */
  available: boolean;
  /** True when `prices` configures a positive price for this label length. */
  priced: boolean;
  /** Price of the name in base units of the payment token. */
  priceBaseUnits: bigint;
  /** Network (sponsorship) fee per network note, from `fee_schedule[root]`. */
  networkFeeBaseUnits: bigint;
  /** True when the registry allows the register script and its fee entry is well formed. */
  scriptAllowed: boolean;
  /** Block of the account proof. */
  blockNum: number;
}

export type RegistrationNoteStatus = 'pending' | 'inflight' | 'discarded' | 'consumed' | 'unknown';

export interface RegistrationNoteState {
  status: RegistrationNoteStatus;
  lastError?: string;
  attemptCount: number;
}

export interface RegistryDeliveryScan {
  /** Ids (hex) of the notes that the registry sent to the account, in chain order. */
  noteIds: string[];
  /** Last block that the scan covered. The next scan can start at scannedTo + 1. */
  scannedTo: number;
}

export interface RegistryMapRequest {
  slot: string;
  keys: Felts4[];
}

export interface RegistryStorageRead {
  blockNum: number;
  /** Value of a map entry. A missing entry is the zero word. */
  mapValue(slot: string, key: Felts4): Felts4;
  slotValue(slot: string): string | undefined;
}

export interface EffectiveScope {
  network: MIDEN_NETWORK_NAME;
  rpcUrl: string;
}

/** Snapshot the effective network and RPC URL at operation entry. */
export function captureEffectiveScope(network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()): EffectiveScope {
  return { network, rpcUrl: getEffectiveRpcUrl() };
}

/** Reject stale results or retries after the active network or RPC URL changed. */
export function assertScopeCurrent(scope: EffectiveScope): void {
  if (getEffectiveNetworkName() !== scope.network || getEffectiveRpcUrl() !== scope.rpcUrl) {
    throw new MidenNameAbortedError();
  }
}

function readWithRpcUrl<T>(scope: EffectiveScope, read: (rpc: RpcClient) => Promise<T>): Promise<T> {
  assertScopeCurrent(scope);
  const rpc = new RpcClient(new Endpoint(scope.rpcUrl));
  let pending: Promise<T>;
  try {
    pending = read(rpc);
  } catch (error) {
    rpc.free();
    throw error;
  }
  void pending.then(
    () => rpc.free(),
    () => rpc.free()
  );
  return pending;
}

function requireConfig(): MidenNameConfig {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return config;
}

type OwnedRpcRunner = <R>(op: (rpc: RpcClient) => Promise<R>, callLabel: string) => Promise<R>;

async function withOwnedRpcClient<T>(scope: EffectiveScope, run: (runRpc: OwnedRpcRunner) => Promise<T>): Promise<T> {
  await ensureSdkWasmReady();
  assertScopeCurrent(scope);
  const rpc = new RpcClient(new Endpoint(scope.rpcUrl));
  const pending: Promise<void>[] = [];
  const runRpc: OwnedRpcRunner = (op, callLabel) =>
    withRpcTimeout(() => {
      assertScopeCurrent(scope);
      const attempt = op(rpc);
      pending.push(
        attempt.then(
          () => undefined,
          () => undefined
        )
      );
      return attempt;
    }, callLabel);
  try {
    return await run(runRpc);
  } finally {
    void Promise.all(pending).then(() => rpc.free());
  }
}

export interface ReadRegistryStorageOptions {
  slotNames?: readonly string[];
  scope?: EffectiveScope;
}

/**
 * Read map entries of the registry with ONE `getAccountProof`. Also makes sure
 * that the proof is for the registry and that `commitment_version` is 1.
 * Snapshots requested slot and map values and frees `AccountProof` before returning.
 */
export async function readRegistryStorage(
  config: MidenNameConfig,
  requests: RegistryMapRequest[],
  label: string,
  options?: ReadRegistryStorageOptions
): Promise<RegistryStorageRead> {
  const scope = options?.scope ?? captureEffectiveScope(config.network);
  await ensureSdkWasmReady();
  assertScopeCurrent(scope);
  const registryHex = config.registryAccountIdHex.toLowerCase();

  const proof = await withRpcTimeout(
    () =>
      readWithRpcUrl(scope, rpc =>
        rpc.getAccountProof(
          AccountId.fromHex(config.registryAccountIdHex),
          AccountStorageRequirements.fromSlotAndKeysArray(
            requests.map(request => new SlotAndKeys(request.slot, request.keys.map(wordFromFelts)))
          )
        )
      ),
    label
  );

  let blockNum: number;
  const slotValuesByName = new Map<string, string | undefined>();
  const entriesBySlot = new Map<string, Map<string, Felts4>>();

  try {
    assertScopeCurrent(scope);
    const provenId = proof.accountId().toString().toLowerCase();
    if (provenId !== registryHex) {
      throw new MidenNameRegistryMismatchError(`proof is for ${provenId}, expected ${registryHex}`);
    }

    const versionWord = proof.getStorageSlotValue(MIDEN_NAME_SLOTS.commitmentVersion);
    const version = versionWord ? feltsFromWord(versionWord)[0] : undefined;
    if (version !== MIDEN_NAME_COMMITMENT_VERSION) {
      throw new MidenNameRegistryMismatchError(`unsupported commitment_version ${String(version)}`);
    }

    blockNum = proof.blockNum();
    for (const slot of options?.slotNames ?? []) {
      slotValuesByName.set(slot, proof.getStorageSlotValue(slot)?.toHex().toLowerCase());
    }

    for (const { slot } of requests) {
      if (proof.hasStorageMapTooManyEntries(slot) === true) {
        throw new MidenNameRegistryMismatchError(`node did not return the entries of ${slot}`);
      }
      const entries = new Map<string, Felts4>();
      for (const entry of proof.getStorageMapEntries(slot) ?? []) {
        entries.set(entry.key().toHex().toLowerCase(), feltsFromWord(entry.value()));
      }
      entriesBySlot.set(slot, entries);
    }
  } finally {
    proof.free();
  }

  return {
    blockNum,
    slotValue(slot: string): string | undefined {
      return slotValuesByName.get(slot);
    },
    mapValue(slot: string, key: Felts4): Felts4 {
      return entriesBySlot.get(slot)?.get(wordFromFelts(key).toHex().toLowerCase()) ?? ZERO_FELTS;
    }
  };
}

const quoteCache = new Map<string, { quote: MidenNameQuote; at: number }>();

/** Clear the quote cache. Tests use this. */
export function clearMidenNameQuoteCache(): void {
  quoteCache.clear();
}

/**
 * Read the availability, price, network fee and script allowlist state of a
 * label with ONE account proof. The result stays in a cache for 30 s; use
 * `fresh: true` to read the chain again (for example before a submit).
 *
 * Throws MidenNameInvalidLabelError for an invalid label and
 * MidenNameUnsupportedNetworkError on a network with no deployment.
 */
export async function fetchMidenNameQuote(label: string, { fresh = false } = {}): Promise<MidenNameQuote> {
  const config = requireConfig();
  const domainWord = encodeDomainFelts(label);
  const scope = captureEffectiveScope(config.network);
  const cacheKey = `${scope.network}|${scope.rpcUrl}|${label}`;
  const cached = quoteCache.get(cacheKey);
  if (!fresh && cached && Date.now() - cached.at < QUOTE_CACHE_TTL_MS) {
    return cached.quote;
  }

  await ensureSdkWasmReady();
  assertScopeCurrent(scope);

  const registry = idPartsFromHex(config.registryAccountIdHex);
  const token = idPartsFromHex(config.paymentFaucetIdHex);
  const statusKey = statusKeyFeltsForLabel(label, registry);
  const priceKey = priceKeyFelts(Number(domainWord[3]), token);
  const scriptRoot = feltsFromWord(Word.fromHex(MIDEN_NAME_REGISTER_SCRIPT_ROOT));

  const storage = await readRegistryStorage(
    config,
    [
      { slot: MIDEN_NAME_SLOTS.assetStatus, keys: [statusKey] },
      { slot: MIDEN_NAME_SLOTS.prices, keys: [priceKey] },
      { slot: MIDEN_NAME_SLOTS.feeSchedule, keys: [scriptRoot] }
    ],
    'midenNameQuote',
    { slotNames: [MIDEN_NAME_SLOTS.registerDomainNoteRoot], scope }
  );

  const status = storage.mapValue(MIDEN_NAME_SLOTS.assetStatus, statusKey);
  const price = storage.mapValue(MIDEN_NAME_SLOTS.prices, priceKey);
  const allowed =
    storage.slotValue(MIDEN_NAME_SLOTS.registerDomainNoteRoot) ===
    Word.fromHex(MIDEN_NAME_REGISTER_SCRIPT_ROOT).toHex().toLowerCase();
  const fee = storage.mapValue(MIDEN_NAME_SLOTS.feeSchedule, scriptRoot);

  // The contract writes a fee entry as [fee, 0, 0, 1]. Any other layout means
  // that the fee policy changed, so this wallet does not submit.
  const feeWellFormed = fee[1] === 0n && fee[2] === 0n && fee[3] === MIDEN_NAME_FEE_ENTRY_MARKER;
  const priced = price[0] > 0n;

  const quote: MidenNameQuote = {
    label,
    available: status[0] === 0n && priced,
    priced,
    priceBaseUnits: price[0],
    networkFeeBaseUnits: feeWellFormed ? fee[0] : 0n,
    scriptAllowed: allowed && feeWellFormed,
    blockNum: storage.blockNum
  };
  quoteCache.set(cacheKey, { quote, at: Date.now() });
  return quote;
}

/** True when the registry has issued the name (`asset_status` felt 0 is 1). */
export async function fetchMidenNameIssued(label: string): Promise<boolean> {
  const config = requireConfig();
  encodeDomainFelts(label);
  const scope = captureEffectiveScope(config.network);
  await ensureSdkWasmReady();
  assertScopeCurrent(scope);
  const registry = idPartsFromHex(config.registryAccountIdHex);
  const statusKey = statusKeyFeltsForLabel(label, registry);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.assetStatus, keys: [statusKey] }],
    'midenNameIssued',
    { scope }
  );
  return storage.mapValue(MIDEN_NAME_SLOTS.assetStatus, statusKey)[0] === MIDEN_NAME_ISSUED_MARKER;
}

function toRegistrationNoteStatus(raw: string): RegistrationNoteStatus {
  switch (raw) {
    case 'Pending':
      return 'pending';
    case 'NullifierInflight':
      return 'inflight';
    case 'Discarded':
      return 'discarded';
    case 'NullifierCommitted':
      return 'consumed';
    default:
      return 'unknown';
  }
}

/**
 * True when the node refuses a status read because it does not know the note
 * yet (gRPC "resource not found").
 */
const NOTE_NOT_FOUND_RPC = /get_network_note_status|failed to get network note status/i;
const NOTE_NOT_FOUND_EXCLUSION = /\b(?:404|route not found|account\s+\S+\s+not found)\b/i;
const NOTE_NOT_FOUND_REASON =
  /\b(?:resource not found|some requested entity was not found|network note\b[^.\n]*\bnot found)\b/i;

function isNoteNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!NOTE_NOT_FOUND_RPC.test(message) || NOTE_NOT_FOUND_EXCLUSION.test(message)) {
    return false;
  }
  return NOTE_NOT_FOUND_REASON.test(message);
}

/**
 * Read the network-note status of the register request note. When the
 * network-transaction builder does not know the note yet, the node gives
 * "resource not found". This function returns 'unknown' for that case, so that
 * the tracker continues to wait. It throws all other errors.
 */
export async function fetchRegistrationNoteState(noteIdHex: string): Promise<RegistrationNoteState> {
  const scope = captureEffectiveScope();
  await ensureSdkWasmReady();
  assertScopeCurrent(scope);
  let info;
  try {
    // No retry: a retry of a "not found" gives the same result.
    info = await withRpcTimeout(
      () => readWithRpcUrl(scope, rpc => rpc.getNetworkNoteStatus(NoteId.fromHex(noteIdHex))),
      'midenNameRegistrationNoteStatus',
      { retries: 0 }
    );
  } catch (error) {
    assertScopeCurrent(scope);
    if (isNoteNotFoundError(error)) return { status: 'unknown', attemptCount: 0 };
    throw error;
  }
  assertScopeCurrent(scope);
  const lastError = info.lastError;
  return {
    status: toRegistrationNoteStatus(info.status),
    attemptCount: info.attemptCount,
    ...(lastError !== undefined ? { lastError } : {})
  };
}

/**
 * Of `noteIds`, the public notes that carry the name NFA of `label`. A note
 * with no public body cannot be checked and is not returned: the registry
 * sends every delivery and return note as a public P2ID note.
 */
async function notesCarryingLabel(
  runRpc: OwnedRpcRunner,
  noteIds: string[],
  label: string,
  registryHex: string
): Promise<string[]> {
  if (noteIds.length === 0) return [];
  const fetched = await runRpc(
    rpc => rpc.getNotesById(noteIds.map(id => NoteId.fromHex(id))),
    'midenNameDeliveryNotes'
  );
  const matching: string[] = [];
  for (const entry of fetched) {
    const id = entry.noteId.toString();
    const note = entry.note;
    if (!note) {
      console.warn('[miden-name] delivery note has no public body; it cannot be matched to a name', { noteId: id });
      continue;
    }
    if (nfasCarryLabel(note.assets().nonFungibleAssets(), label, registryHex)) matching.push(id);
  }
  // Keep the chain order of the scan.
  return noteIds.filter(id => matching.includes(id));
}

/**
 * Find the notes that the registry sent to an account in [fromBlock, toBlock]
 * (toBlock defaults to the chain tip). `syncNotes` can stop before the end of
 * the range, so this loops with a cursor until `blockTo()` reaches the end.
 *
 * With `label`, only the notes that carry the name NFA of that label are
 * returned. The registry can deliver the notes of two names in any order, so
 * a caller that follows one registration must pass its label.
 */
export async function findRegistryDeliveryNoteIds({
  accountId,
  fromBlock,
  toBlock,
  label
}: {
  accountId: string;
  fromBlock: number;
  toBlock?: number;
  label?: string;
}): Promise<RegistryDeliveryScan> {
  const config = requireConfig();
  const scope = captureEffectiveScope(config.network);
  const registryHex = config.registryAccountIdHex.toLowerCase();
  fromBlock = Math.max(fromBlock, config.registryCreationBlock);
  const end = toBlock ?? (await getChainTip(scope));
  if (fromBlock > end) return { noteIds: [], scannedTo: end };

  return withOwnedRpcClient(scope, async runRpc => {
    const noteIds: string[] = [];
    const seen = new Set<string>();
    let cursor = fromBlock;
    let scannedTo = fromBlock - 1;

    for (let round = 0; round < MAX_DELIVERY_SCAN_ROUNDS && cursor <= end; round++) {
      const from = cursor;
      const info = await runRpc(
        rpc => rpc.syncNotes(from, end, [NoteTag.withAccountTarget(walletAccountIdToSdk(accountId))]),
        'midenNameDeliveryScan'
      );
      assertScopeCurrent(scope);
      for (const block of info.blocks()) {
        for (const note of block.notes()) {
          if (note.sender().toString().toLowerCase() !== registryHex) continue;
          const id = note.noteId().toString();
          if (seen.has(id)) continue;
          seen.add(id);
          noteIds.push(id);
        }
      }
      const reached = Math.min(info.blockTo(), end);
      // A node that does not move the cursor forward stops the scan here, so
      // the loop cannot run with no progress.
      if (reached < from) break;
      scannedTo = reached;
      cursor = reached + 1;
    }

    if (label === undefined) return { noteIds, scannedTo };
    const matching = await notesCarryingLabel(runRpc, noteIds, label, registryHex);
    assertScopeCurrent(scope);
    return { noteIds: matching, scannedTo };
  });
}

/** The chain tip block number for the captured or effective RPC endpoint. */
export async function getChainTip(scope: EffectiveScope = captureEffectiveScope()): Promise<number> {
  await ensureSdkWasmReady();
  assertScopeCurrent(scope);
  const header = await withRpcTimeout(
    () => readWithRpcUrl(scope, rpc => rpc.getBlockHeaderByNumber(undefined)),
    'midenNameChainTip'
  );
  assertScopeCurrent(scope);
  return Number(header.blockNum());
}
