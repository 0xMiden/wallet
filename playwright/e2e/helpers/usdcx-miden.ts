/**
 * Typed wrapper of `usdcx-chain-evidence.mjs`, the Miden chain oracle the USDCx suites check the wallet against. The
 * oracle runs in a child process with its own copy of the SDK's WASM, independent of the wallet under test. Every id it
 * is handed is bare: a composite `<bech32>_<suffix>` id is cut to its bech32 first.
 */
import { execFile } from 'child_process';
import path from 'path';
import { isAddress, isHex, type Address, type Hash, type Hex } from 'viem';

import { FEE_RESERVE_MULTIPLE, realArcClock, type ArcClock } from './usdcx-constants';

export type ChainEvidenceRunner = (
  args: readonly string[],
  opts: { timeoutMs: number; stdin?: string }
) => Promise<string>;

const CHAIN_EVIDENCE_SCRIPT = path.join(__dirname, 'usdcx-chain-evidence.mjs');
const RUN_TIMEOUT_MS = 30_000;
// A burn's result bytes run to ~320 KB, ~430 KB as base64 on stdin; stdout is one JSON line.
const MAX_BUFFER = 16 * 1024 * 1024;

/** The failing assertion's line from the oracle's stderr, or its last lines when there is none. */
function failureLine(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim());
  return lines.find(line => /^[A-Za-z]*Error\b/.test(line)) ?? lines.filter(Boolean).slice(-3).join(' | ');
}

export const runChainEvidence: ChainEvidenceRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CHAIN_EVIDENCE_SCRIPT, ...args],
      { timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`usdcx-chain-evidence ${args[0] ?? ''}: ${failureLine(stderr) || error.message}`, {
              cause: error
            })
          );
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin?.end(opts.stdin ?? '');
  });

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function evidence(
  run: ChainEvidenceRunner,
  args: readonly string[],
  opts: { timeoutMs?: number; stdin?: string } = {}
): Promise<JsonRecord> {
  const stdout = await run(args, { timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS, stdin: opts.stdin });
  const line = stdout.trim().split('\n').pop() ?? '';
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error(`usdcx-chain-evidence ${args[0] ?? ''} printed ${line}, not a JSON object`);
  return parsed;
}

function field(record: JsonRecord, key: string, what: string): unknown {
  if (!(key in record)) throw new Error(`usdcx-chain-evidence ${what}: no ${key} in ${JSON.stringify(record)}`);
  return record[key];
}

function textField(record: JsonRecord, key: string, what: string): string {
  const value = field(record, key, what);
  if (typeof value !== 'string') throw new Error(`usdcx-chain-evidence ${what}: ${key} is not a string`);
  return value;
}

function hexField(record: JsonRecord, key: string, what: string): Hex {
  const value = textField(record, key, what);
  if (!isHex(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} ${value} is not hex`);
  return value;
}

function numberField(record: JsonRecord, key: string, what: string): number {
  const value = field(record, key, what);
  if (typeof value !== 'number') throw new Error(`usdcx-chain-evidence ${what}: ${key} is not a number`);
  return value;
}

function unitsField(record: JsonRecord, key: string, what: string): bigint {
  const value = textField(record, key, what);
  if (!/^\d+$/.test(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} ${value} is not a decimal amount`);
  return BigInt(value);
}

function recordField(record: JsonRecord, key: string, what: string): JsonRecord {
  const value = field(record, key, what);
  if (!isRecord(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} is not an object`);
  return value;
}

/** The bech32 part of a composite `<bech32>_<suffix>` id; a bare id comes back unchanged. */
export function bareId(id: string): string {
  return id.split('_')[0] ?? id;
}

/** The account id hex (`0x` + 30 hex) of a bech32 or composite address. */
export async function accountHex(
  bech32OrComposite: string,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<string> {
  const hex = textField(await evidence(run, ['account-hex', bareId(bech32OrComposite)]), 'hex', 'account-hex');
  if (!/^0x[0-9a-f]{30}$/.test(hex)) throw new Error(`usdcx-chain-evidence account-hex: ${hex} is not an account id`);
  return hex;
}

/** The faucet's token supply, base units. */
export async function supply(
  rpcUrl: string,
  faucetBech32: string,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<bigint> {
  return unitsField(await evidence(run, ['supply', rpcUrl, bareId(faucetBech32)]), 'supply', 'supply');
}

export interface BurnEvidence {
  noteId: Hex;
  amount: bigint;
  tag: number;
  scriptRoot: Hex;
  senderHex: string;
  domain: number;
  recipient: Address;
  /** The faucet's live `fee_schedule[burn root][0]`: what a burn pays it to execute the note. */
  sponsorshipUnits: bigint;
  status: string;
  nullifierCommitted: boolean;
  consumeBlock: number;
  consumeTimestampSec: number;
  attemptCount?: number;
}

/**
 * The burn note as the node holds it, checked canonical byte for byte against the burn the wallet should have built
 * (asset, storage, the network-account target and the withdrawal attachment to `domain` and `recipient`), plus the
 * block and time the faucet consumed it. Throws naming the verdict when it was never committed or not consumed.
 */
export async function burnEvidence(
  rpcUrl: string,
  args: { faucetBech32: string; noteId: Hex; senderBech32: string; domain: number; recipient: Address; amount: bigint },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<BurnEvidence> {
  const what = 'burn-evidence';
  const out = await evidence(run, [
    'burn-evidence',
    rpcUrl,
    bareId(args.faucetBech32),
    args.noteId,
    bareId(args.senderBech32),
    String(args.domain),
    args.recipient,
    args.amount.toString()
  ]);
  const recipient = textField(out, 'recipient', what);
  if (!isAddress(recipient, { strict: false })) throw new Error(`usdcx-chain-evidence ${what}: recipient ${recipient}`);
  const attemptCount = out.attemptCount;
  return {
    noteId: hexField(out, 'noteId', what),
    amount: unitsField(out, 'amount', what),
    tag: numberField(out, 'tag', what),
    scriptRoot: hexField(out, 'scriptRoot', what),
    senderHex: textField(out, 'senderHex', what),
    domain: numberField(out, 'domain', what),
    recipient,
    sponsorshipUnits: unitsField(out, 'sponsorshipUnits', what),
    status: textField(out, 'status', what),
    nullifierCommitted: field(out, 'nullifierCommitted', what) === true,
    consumeBlock: numberField(out, 'consumeBlock', what),
    consumeTimestampSec: numberField(out, 'consumeTimestampSec', what),
    attemptCount: typeof attemptCount === 'number' ? attemptCount : undefined
  };
}

export interface BurnOutputs {
  burn: { noteId: Hex; amount: bigint };
  sponsorship: { noteId: Hex; amount: bigint };
  fee: { noteId: Hex; amount: bigint };
}

/** A burn row's `resultBytes` (base64) decoded by role. (spike-dependent: decode-by-role validated by spec 14 step 1) */
export async function burnOutputs(
  args: { resultBytesBase64: string; burnNoteId: Hex; faucetBech32: string },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<BurnOutputs> {
  const what = 'burn-outputs';
  const out = await evidence(run, ['burn-outputs', bareId(args.faucetBech32), args.burnNoteId], {
    stdin: args.resultBytesBase64
  });
  const role = (key: string) => {
    const entry = recordField(out, key, what);
    return {
      noteId: hexField(entry, 'noteId', `${what} ${key}`),
      amount: unitsField(entry, 'amount', `${what} ${key}`)
    };
  };
  return { burn: role('burn'), sponsorship: role('sponsorship'), fee: role('fee') };
}

/**
 * The id of the note miden-usdcx 0.17.1 mints for a deposit: a P2ID to `recipientHex` of `units`, its serial the
 * Poseidon2 hash of the DepositIntent nonce (offset 204). Pinned by two minted deposits in usdcx-miden.test.ts.
 */
export async function deriveUsdcxMintNoteId(
  args: { faucetHex: string; recipientHex: string; units: bigint; nonce: Hex },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<Hex> {
  const out = await evidence(run, [
    'mint-note-id',
    args.faucetHex,
    args.recipientHex,
    args.units.toString(),
    args.nonce
  ]);
  return hexField(out, 'noteId', 'mint-note-id');
}

export interface MidenNoteRead {
  noteId: Hex;
  found: boolean;
  committed: boolean;
  senderHex?: string;
  tag?: number;
  assets: Array<{ faucetHex: string; amount: bigint }>;
}

/** A note as the node serves it by id; `found: false` until a block includes it. */
export async function note(
  rpcUrl: string,
  noteId: Hex,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<MidenNoteRead> {
  const what = 'note';
  const out = await evidence(run, ['note', rpcUrl, noteId]);
  const assets = field(out, 'assets', what);
  if (!Array.isArray(assets)) throw new Error(`usdcx-chain-evidence ${what}: assets is not a list`);
  const senderHex = out.senderHex;
  const tag = out.tag;
  return {
    noteId: hexField(out, 'noteId', what),
    found: field(out, 'found', what) === true,
    committed: field(out, 'committed', what) === true,
    senderHex: typeof senderHex === 'string' ? senderHex : undefined,
    tag: typeof tag === 'number' ? tag : undefined,
    assets: assets.map(asset => {
      if (!isRecord(asset)) throw new Error(`usdcx-chain-evidence ${what}: an asset is not an object`);
      return { faucetHex: textField(asset, 'faucetHex', what), amount: unitsField(asset, 'amount', what) };
    })
  };
}

/** Whether a public note's nullifier is committed, and in which block. */
export async function nullifier(
  rpcUrl: string,
  noteId: Hex,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<{ committed: boolean; blockNum?: number }> {
  const out = await evidence(run, ['nullifier', rpcUrl, noteId]);
  const blockNum = out.blockNum;
  return {
    committed: field(out, 'committed', 'nullifier') === true,
    blockNum: typeof blockNum === 'number' ? blockNum : undefined
  };
}

/** Best-effort: the public notes the faucet sent to the account's tag since `sinceBlock`; [] on any oracle error. */
export async function recentNotes(
  rpcUrl: string,
  args: { faucetBech32: string; accountBech32: string; sinceBlock: number },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<Hex[]> {
  try {
    const out = await evidence(run, [
      'recent-notes',
      rpcUrl,
      bareId(args.faucetBech32),
      bareId(args.accountBech32),
      String(args.sinceBlock)
    ]);
    const ids = field(out, 'noteIds', 'recent-notes');
    return Array.isArray(ids) ? ids.filter((id): id is Hex => typeof id === 'string' && isHex(id)) : [];
  } catch {
    return [];
  }
}

/**
 * Polls `note(mintNoteId)` until the node has it. The timeout names Circle's relayer and the USDCx faucet (never the
 * public faucet), the deposit hash, the nonce, the derived id, and the faucet's recent notes to the account.
 */
export async function waitForUsdcxMint(
  rpcUrl: string,
  args: {
    mintNoteId: Hex;
    depositHash: Hash;
    nonce: Hex;
    faucetBech32: string;
    accountBech32: string;
    sinceBlock: number;
    timeoutMs: number;
    pollMs?: number;
  },
  deps: { run?: ChainEvidenceRunner; clock?: ArcClock } = {}
): Promise<MidenNoteRead> {
  const run = deps.run ?? runChainEvidence;
  const clock = deps.clock ?? realArcClock;
  const deadline = clock.now() + args.timeoutMs;
  let lastError = '';
  for (;;) {
    try {
      const read = await note(rpcUrl, args.mintNoteId, run);
      if (read.found) return read;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(args.pollMs ?? 3_000);
  }
  const recent = await recentNotes(rpcUrl, args, run);
  throw new Error(
    `Circle's relayer has not minted deposit ${args.depositHash} through the USDCx faucet ${bareId(args.faucetBech32)} ` +
      `within ${args.timeoutMs} ms.\n` +
      `  nonce: ${args.nonce}\n` +
      `  derived mint note id: ${args.mintNoteId}\n` +
      `  the faucet's notes to ${bareId(args.accountBech32)} since block ${args.sinceBlock}: ` +
      `${recent.length === 0 ? 'none' : recent.join(', ')}` +
      (lastError ? `\n  last oracle error: ${lastError}` : '')
  );
}

/**
 * Q5(d): the fee of a landed path, which records none. Both terms are signed debits: `vaultDelta` is the vault before
 * minus after, `knownTerms` every other debit (a credit counts negative). A burn: V1 - V2 and N + s. A consume of M:
 * V2 - V3 and -M. Throws unless 0 < fee <= baseFee x FEE_RESERVE_MULTIPLE.
 */
export function boundLandedFee(args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): {
  fee: bigint;
  ceiling: bigint;
} {
  const fee = args.vaultDelta - args.knownTerms;
  const ceiling = BigInt(args.baseFee) * BigInt(FEE_RESERVE_MULTIPLE);
  if (fee <= 0n || fee > ceiling) {
    throw new Error(
      `landed-path fee ${fee} (vault delta ${args.vaultDelta} minus known terms ${args.knownTerms}) is outside ` +
        `(0, ${ceiling}], the bound baseFee ${args.baseFee} x ${FEE_RESERVE_MULTIPLE}`
    );
  }
  return { fee, ceiling };
}
