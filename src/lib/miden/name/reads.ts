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
  NoteId,
  NoteTag,
  RpcClient,
  SlotAndKeys,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { walletAccountIdToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import {
  MIDEN_NAME_ALLOWED_SCRIPT_MARKER,
  MIDEN_NAME_COMMITMENT_VERSION,
  MIDEN_NAME_FEE_ENTRY_MARKER,
  MIDEN_NAME_ISSUED_MARKER,
  MIDEN_NAME_REGISTER_SCRIPT_ROOT,
  MIDEN_NAME_SLOTS,
  type MidenNameConfig,
  getMidenNameConfig
} from './config';
import { traceRegistryStep } from './debug';
import { type Felts4, encodeDomainFelts, priceKeyFelts } from './encoding';
import { MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import { feltsFromWord, idPartsFromHex, statusKeyFeltsForLabel, wordFromFelts } from './sdk-words';

const ZERO_FELTS: Felts4 = [0n, 0n, 0n, 0n];
const QUOTE_CACHE_TTL_MS = 30_000;

/** Upper limit of `syncNotes` rounds in one delivery scan. */
const MAX_DELIVERY_SCAN_ROUNDS = 200;

export interface MidenNameQuote {
  label: string;
  /** True when `asset_status` felt 0 is 0 (no one has the name). */
  available: boolean;
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
}

function requireConfig(): MidenNameConfig {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return config;
}

async function newRpcClient(): Promise<RpcClient> {
  await ensureSdkWasmReady();
  return new RpcClient(getRpcEndpoint());
}

/**
 * Read map entries of the registry with ONE `getAccountProof`. Also makes sure
 * that the proof is for the registry and that `commitment_version` is 1.
 */
export async function readRegistryStorage(
  config: MidenNameConfig,
  requests: RegistryMapRequest[],
  label: string
): Promise<RegistryStorageRead> {
  const trace = label.startsWith('midenNameResolve');
  const rpc = await traceRegistryStep('resolve.rpc-ready', newRpcClient, { read: label }, trace);
  const registryHex = config.registryAccountIdHex.toLowerCase();
  let attempt = 0;

  const proof = await withRpcTimeout(
    () =>
      traceRegistryStep(
        'resolve.account-proof',
        () =>
          rpc.getAccountProof(
            AccountId.fromHex(config.registryAccountIdHex),
            AccountStorageRequirements.fromSlotAndKeysArray(
              requests.map(request => new SlotAndKeys(request.slot, request.keys.map(wordFromFelts)))
            )
          ),
        { read: label, attempt: ++attempt },
        trace
      ),
    label
  );

  const provenId = proof.accountId().toString().toLowerCase();
  if (provenId !== registryHex) {
    throw new MidenNameRegistryMismatchError(`proof is for ${provenId}, expected ${registryHex}`);
  }

  const versionWord = proof.getStorageSlotValue(MIDEN_NAME_SLOTS.commitmentVersion);
  const version = versionWord ? feltsFromWord(versionWord)[0] : undefined;
  if (version !== MIDEN_NAME_COMMITMENT_VERSION) {
    throw new MidenNameRegistryMismatchError(`unsupported commitment_version ${String(version)}`);
  }

  const entriesBySlot = new Map<string, Map<string, Felts4>>();
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

  return {
    blockNum: proof.blockNum(),
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
  const cacheKey = `${config.network}|${label}`;
  const cached = quoteCache.get(cacheKey);
  if (!fresh && cached && Date.now() - cached.at < QUOTE_CACHE_TTL_MS) {
    return cached.quote;
  }

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
      { slot: MIDEN_NAME_SLOTS.allowedNoteScripts, keys: [scriptRoot] },
      { slot: MIDEN_NAME_SLOTS.feeSchedule, keys: [scriptRoot] }
    ],
    'midenNameQuote'
  );

  const status = storage.mapValue(MIDEN_NAME_SLOTS.assetStatus, statusKey);
  const price = storage.mapValue(MIDEN_NAME_SLOTS.prices, priceKey);
  const allowed = storage.mapValue(MIDEN_NAME_SLOTS.allowedNoteScripts, scriptRoot);
  const fee = storage.mapValue(MIDEN_NAME_SLOTS.feeSchedule, scriptRoot);

  // The contract writes a fee entry as [fee, 0, 0, 1]. Any other layout means
  // that the fee policy changed, so this wallet does not submit.
  const feeWellFormed = fee[1] === 0n && fee[2] === 0n && fee[3] === MIDEN_NAME_FEE_ENTRY_MARKER;

  const quote: MidenNameQuote = {
    label,
    available: status[0] === 0n,
    priceBaseUnits: price[0],
    networkFeeBaseUnits: feeWellFormed ? fee[0] : 0n,
    scriptAllowed: allowed[0] === MIDEN_NAME_ALLOWED_SCRIPT_MARKER && feeWellFormed,
    blockNum: storage.blockNum
  };
  quoteCache.set(cacheKey, { quote, at: Date.now() });
  return quote;
}

/**
 * True when the registry allows a note script (`allowed_note_scripts[root]`
 * felt 0 is 1). The publish guard uses this for the registry script.
 */
export async function fetchRegistryScriptAllowed(scriptRootHex: string): Promise<boolean> {
  const config = requireConfig();
  const scriptRoot = feltsFromWord(Word.fromHex(scriptRootHex));
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.allowedNoteScripts, keys: [scriptRoot] }],
    'midenNameScriptAllowed'
  );
  return storage.mapValue(MIDEN_NAME_SLOTS.allowedNoteScripts, scriptRoot)[0] === MIDEN_NAME_ALLOWED_SCRIPT_MARKER;
}

/** True when the registry has issued the name (`asset_status` felt 0 is 1). */
export async function fetchMidenNameIssued(label: string): Promise<boolean> {
  const config = requireConfig();
  const registry = idPartsFromHex(config.registryAccountIdHex);
  const statusKey = statusKeyFeltsForLabel(label, registry);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.assetStatus, keys: [statusKey] }],
    'midenNameIssued'
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
function isNoteNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('not found');
}

/**
 * Read the network-note status of the register request note. When the
 * network-transaction builder does not know the note yet, the node gives
 * "resource not found". This function returns 'unknown' for that case, so that
 * the tracker continues to wait. It throws all other errors.
 */
export async function fetchRegistrationNoteState(noteIdHex: string): Promise<RegistrationNoteState> {
  const rpc = await newRpcClient();
  let info;
  try {
    // No retry: a retry of a "not found" gives the same result.
    info = await withRpcTimeout(
      () => rpc.getNetworkNoteStatus(NoteId.fromHex(noteIdHex)),
      'midenNameRegistrationNoteStatus',
      { retries: 0 }
    );
  } catch (error) {
    if (isNoteNotFoundError(error)) return { status: 'unknown', attemptCount: 0 };
    throw error;
  }
  const lastError = info.lastError;
  return {
    status: toRegistrationNoteStatus(info.status),
    attemptCount: info.attemptCount,
    ...(lastError !== undefined ? { lastError } : {})
  };
}

/**
 * Find the notes that the registry sent to an account in [fromBlock, toBlock]
 * (toBlock defaults to the chain tip). `syncNotes` can stop before the end of
 * the range, so this loops with a cursor until `blockTo()` reaches the end.
 */
export async function findRegistryDeliveryNoteIds({
  accountId,
  fromBlock,
  toBlock
}: {
  accountId: string;
  fromBlock: number;
  toBlock?: number;
}): Promise<RegistryDeliveryScan> {
  const config = requireConfig();
  const registryHex = config.registryAccountIdHex.toLowerCase();
  const end = toBlock ?? (await getChainTip());
  if (fromBlock > end) return { noteIds: [], scannedTo: end };

  const rpc = await newRpcClient();
  const noteIds: string[] = [];
  const seen = new Set<string>();
  let cursor = fromBlock;
  let scannedTo = fromBlock - 1;

  for (let round = 0; round < MAX_DELIVERY_SCAN_ROUNDS && cursor <= end; round++) {
    const from = cursor;
    const info = await withRpcTimeout(
      () => rpc.syncNotes(from, end, [NoteTag.withAccountTarget(walletAccountIdToSdk(accountId))]),
      'midenNameDeliveryScan'
    );
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

  return { noteIds, scannedTo };
}

/** The chain tip block number. */
export function getChainTip(): Promise<number> {
  return getCurrentMidenBlock();
}
