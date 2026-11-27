// The node reads of the pending-note recovery's public backfill (source 3 of 3).
//
// Everything here reads the node through an `RpcClient` built for that read and
// touches no wallet client, so it runs WITHOUT the WASM client lock and, on the
// extension, in the service worker rather than as an offscreen op (#2266). Only
// the import of the notes it keeps takes the lock
// (`MidenClientInterface.importRecoveryNoteFiles`). A read that held the lock
// for its network time starved the queued reads behind it: their 15 s deadline
// closed the offscreen document, the chunk went with it, and the recovery
// started the same chunk again, forever.
//
// A trap in one of these reads is a failed read: no lock and no client was
// inside the call, so there is no client to retire (the same rule as the
// native-asset fee catches and `lookUpBlock`).

import { Address, Endpoint, type InputNote, type Note, NoteFile, NoteType, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { walletAccountIdToSdk } from './helpers';
import { type AccountFelts, mayEverConsume } from '../helpers';

/**
 * Span at or below which a range is no longer narrowed. A dense range still
 * has to be read eventually, and past this point narrowing has stopped helping
 * (a single block cannot be split); such a range is paged by note count
 * instead, via `nextNoteOffset`.
 */
const MIN_SPLIT_SPAN_BLOCKS = 1_000;

/**
 * Tag matches one read takes. Past this it reports `saturated` and reads no
 * note body, so the caller can come back with halves. The cap bounds the work
 * and the memory of one read, and the number of notes one import op can be
 * handed: anyone can aim note volume at a tag, since a tag is a 14-bit prefix
 * of the account id.
 */
const MAX_NOTES_PER_CHUNK = 200;

/** Note ids per `getNotesById` request. */
const FETCH_BATCH_SIZE = 100;

/** The most significant 16 bits of a nullifier's fourth element (`NULLIFIER_PREFIX_SHIFT`, miden-protocol). */
const NULLIFIER_PREFIX_SHIFT = 48n;

/**
 * One public-backfill read. The two "come back for more" signals are mutually
 * exclusive:
 *
 * `saturated` — the BLOCK RANGE was too big for one read; retry it as halves.
 * `nextNoteOffset` — the range was fine but held more tag matches than one read
 * takes; re-offer the SAME range starting at this match index. Absent means
 * finished.
 */
export type RecoverablePublicNotes = {
  /** Serialized `NoteFile`s, with their inclusion proofs, of the notes to import. */
  noteFiles: Uint8Array[];
  failures: number;
  saturated: boolean;
  nextNoteOffset?: number;
};

/**
 * A node that refuses the requested span because it is too wide is reported
 * as saturated so the caller can retry halves; anything else propagates.
 * Rate limiting must NOT land here:
 * "429 Too Many Requests" would otherwise be read as a span complaint and
 * answered by doubling the number of requests.
 */
function isBlockSpanTooWide(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const rateLimited =
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('resource exhausted') ||
    message.includes('resourceexhausted') ||
    message.includes('429');
  if (rateLimited) return false;
  return (
    message.includes('paginationerror') ||
    message.includes('blockpagination') ||
    message.includes('safety cap') ||
    (message.includes('block') && (message.includes('too many') || message.includes('maximum number')))
  );
}

/**
 * Resolve the public-backfill scan range for a recovered account: binary
 * search block headers for the first block minted after the account was
 * created (Guardian `createdAt`, seconds), with a margin for clock skew.
 * Scanning from the creation block instead of genesis keeps the backfill
 * proportional to the account's age.
 */
export async function resolveRecoveryScanRange(
  createdAtSeconds: number
): Promise<{ startBlock: number; latestBlock: number }> {
  const rpc = new RpcClient(new Endpoint(getEffectiveRpcUrl()));
  // ~log2(tip) sequential header reads, so each one gets a short bound and no
  // retry: a slow node must not stall the recovery here, and the recovery
  // retries the whole range on the next backend start.
  const header = (blockNum?: number) =>
    withRpcTimeout(() => rpc.getBlockHeaderByNumber(blockNum), 'recoveryScanRangeHeader', {
      timeoutMs: 8_000,
      retries: 0
    });

  const latestHeader = await header();
  const latestBlock = latestHeader.blockNum();
  const clockSkewMarginSeconds = 600;
  const target = createdAtSeconds - clockSkewMarginSeconds;
  if (target <= 0) return { startBlock: 0, latestBlock };
  // Timestamps only ever NARROW the scan, and this scan runs once: whatever
  // it skips is skipped forever, because a clean pass clears the one-shot
  // pending flag. `createdAt` comes from the Guardian operator's clock and the
  // headers come from the node, so every way those two can disagree is
  // resolved by scanning MORE, never less.
  if (latestHeader.timestamp() <= target) {
    // The account claims to be newer than the chain tip, yet it demonstrably
    // exists on that chain. One of the two clocks is wrong; starting at the
    // tip would scan a single block, find nothing, and report success. A node
    // that reports no tip timestamp at all lands here too, since `target` is
    // positive by this point.
    console.warn(
      `[GuardianRecovery] Reported creation time is at or beyond the chain tip (tip ` +
        `${latestHeader.timestamp()}, target ${target}); scanning from genesis instead`
    );
    return { startBlock: 0, latestBlock };
  }
  const genesis = await header(0);
  if (genesis.timestamp() >= target) return { startBlock: 0, latestBlock };
  // Invariant: timestamp(lo) < target <= timestamp(hi).
  let lo = 0;
  let hi = latestBlock;
  // A bound on the whole search as well as the bisection: ~log2(tip) reads at
  // 8 s each would keep the recovery here for minutes on a slow node. Stopping
  // early only widens the scan — `lo` is always a block older than the account,
  // which is exactly what the backfill needs — so a slow node costs extra
  // scanned blocks rather than a stalled recovery.
  const searchDeadline = Date.now() + 20_000;
  while (lo + 1 < hi) {
    if (Date.now() > searchDeadline) {
      console.warn(
        `[GuardianRecovery] Creation-block search ran out of budget; scanning from block ${lo} (widened range)`
      );
      break;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const midHeader = await header(mid);
    const midTimestamp = midHeader.timestamp();
    // The bisection is only valid over monotonically increasing timestamps.
    // A zero or absent one breaks that invariant and would push `lo` past the
    // account's real creation block, silently skipping its history.
    if (midTimestamp <= 0) {
      console.warn(`[GuardianRecovery] Block ${mid} reported no timestamp; scanning from genesis instead`);
      return { startBlock: 0, latestBlock };
    }
    if (midTimestamp < target) lo = mid;
    else hi = mid;
  }
  return { startBlock: lo, latestBlock };
}

type Candidate = { inputNote: InputNote; note: Note; nullifier: string };

function nullifierPrefix(note: Note): number {
  // A missing element reads as prefix 0: the node then reports no spend for the note, which is imported anyway.
  return Number((note.nullifier().toU64s()[3] ?? 0n) >> NULLIFIER_PREFIX_SHIFT);
}

/**
 * The nullifiers among `candidates` that the node shows spent, read in ONE
 * request for the whole page. A failed read spends nothing: the filter only
 * saves imports, and a spent note that is imported anyway is marked consumed
 * by the next sync.
 */
async function spentNullifiers(rpc: RpcClient, notes: Note[], blockFrom: number): Promise<Set<string>> {
  try {
    const tip = (
      await withRpcTimeout(() => rpc.getBlockHeaderByNumber(), 'recoveryNullifierTip', { retries: 0 })
    ).blockNum();
    const prefixes = new Uint16Array([...new Set(notes.map(nullifierPrefix))]);
    const updates = await withRpcTimeout(
      () => rpc.syncNullifiers(prefixes, blockFrom, Math.max(blockFrom, tip)),
      'recoveryNullifiers',
      { retries: 0 }
    );
    return new Set(updates.map(update => update.nullifier().toHex()));
  } catch (error) {
    console.warn('[GuardianRecovery] Nullifier check failed; importing the notes without it:', error);
    return new Set();
  }
}

/**
 * Read the committed public notes whose tag matches the account over ONE
 * bounded block range, and keep only those the account can consume and that
 * are not spent. The tag is a 14-bit prefix of the account id, so on a busy
 * chain most matches belong to other accounts, and most of the rest were
 * consumed long ago: importing them only held the client.
 *
 * Narrowing is the CALLER's job: `saturated` hands the range back to be split,
 * so no single read grows with the range.
 */
export async function readRecoverablePublicNotes(
  accountId: string,
  blockFrom: number,
  blockTo: number,
  noteOffset = 0
): Promise<RecoverablePublicNotes> {
  const rpc = new RpcClient(new Endpoint(getEffectiveRpcUrl()));
  const account = walletAccountIdToSdk(accountId);
  const owner: AccountFelts = {
    prefix: account.prefix().asInt().toString(),
    suffix: account.suffix().asInt().toString()
  };
  const noteTag = Address.fromAccountId(account).toNoteTag();
  const splittable = blockTo - blockFrom + 1 > MIN_SPLIT_SPAN_BLOCKS;

  let syncInfo;
  try {
    // Bounded, no retry. The no-retry part is load-bearing for correctness:
    // this call MOVES `noteTag` into Rust, so a second attempt would hand it a
    // dead handle.
    syncInfo = await withRpcTimeout(() => rpc.syncNotes(blockFrom, blockTo, [noteTag]), 'recoverySyncNotes', {
      timeoutMs: 30_000,
      retries: 0
    });
  } catch (error) {
    if (splittable && isBlockSpanTooWide(error)) return { noteFiles: [], failures: 0, saturated: true };
    throw error;
  }

  const allCommittedNotes = syncInfo.notes();
  if (splittable && allCommittedNotes.length > MAX_NOTES_PER_CHUNK) {
    // Nothing read on purpose: the halves re-scan their own sub-ranges.
    console.log(
      `[GuardianRecovery] Public backfill blocks ${blockFrom}-${blockTo}: ${allCommittedNotes.length} tag matches ` +
        `exceeds ${MAX_NOTES_PER_CHUNK} per read; asking the caller for a narrower range`
    );
    return { noteFiles: [], failures: 0, saturated: true };
  }

  // Below the split floor a dense range cannot be narrowed further, so it is
  // paged by NOTE instead: the read takes at most `MAX_NOTES_PER_CHUNK` matches
  // and hands back where to continue. Without this, an unsplittable window
  // holding thousands of matches would be one unbounded read and one unbounded
  // import op.
  const committedNotes = allCommittedNotes.slice(noteOffset, noteOffset + MAX_NOTES_PER_CHUNK);
  const consumedTo = noteOffset + committedNotes.length;
  const nextNoteOffset = consumedTo < allCommittedNotes.length ? consumedTo : undefined;

  let failures = 0;
  // A PRIVATE tag match carries no body over RPC by design (the SDK documents
  // `note` as undefined for private notes). It belongs to the transport drain
  // (source 1), so it is not a failure of this source.
  let skippedPrivate = 0;
  let unexpected = 0;
  let otherAccounts = 0;
  const candidates: Candidate[] = [];
  for (let start = 0; start < committedNotes.length; start += FETCH_BATCH_SIZE) {
    const noteIds = committedNotes.slice(start, start + FETCH_BATCH_SIZE).map(note => note.noteId());
    // Read BEFORE the call: passing these into `getNotesById` MOVES them into
    // Rust (wasm-bindgen unwraps every element and zeroes the JS wrapper's
    // pointer), so afterwards each one is a dead handle and stringifying it
    // traps. Only the array's length survives the call.
    //
    // Resolved BY ID, not by count. A response of the right length can still
    // be the wrong notes — duplicates of one id, or ids never asked for —
    // and counting length alone would read that as a clean chunk, letting
    // the orchestrator clear the one-shot flag over notes never imported.
    const requestedIds = new Set(noteIds.map(String));
    const fetchedNotes = await withRpcTimeout(() => rpc.getNotesById(noteIds), 'recoveryGetNotesById', {
      retries: 0
    });
    const answeredIds = new Set<string>();
    for (const fetched of fetchedNotes) {
      const noteId = String(fetched.noteId);
      if (!requestedIds.has(noteId) || answeredIds.has(noteId)) {
        unexpected++;
        continue;
      }
      answeredIds.add(noteId);
      const inputNote = fetched.asInputNote();
      if (!inputNote) {
        // A body-less PUBLIC note is the node failing to serve what it said
        // it had, not an expected private note.
        if (fetched.noteType === NoteType.Public) {
          failures++;
          console.warn(`[GuardianRecovery] Node returned public note ${noteId} without a body`);
        } else {
          skippedPrivate++;
        }
        continue;
      }
      const note = inputNote.note();
      if (!mayEverConsume(note, owner)) {
        otherAccounts++;
        continue;
      }
      candidates.push({ inputNote, note, nullifier: note.nullifier().toHex() });
    }
    failures += noteIds.length - answeredIds.size;
  }

  const spent =
    candidates.length > 0
      ? await spentNullifiers(
          rpc,
          candidates.map(candidate => candidate.note),
          blockFrom
        )
      : new Set<string>();
  const kept = candidates.filter(candidate => !spent.has(candidate.nullifier));
  console.log(
    `[GuardianRecovery] Public backfill blocks ${blockFrom}-${blockTo} notes ${noteOffset}-${consumedTo} of ` +
      `${allCommittedNotes.length} tag matches: ${kept.length} to import, ${otherAccounts} for other accounts, ` +
      `${candidates.length - kept.length} spent, ${skippedPrivate} private, ${unexpected} unrequested/duplicate, ` +
      `${failures} failed`
  );
  return {
    noteFiles: kept.map(candidate => NoteFile.fromInputNote(candidate.inputNote).serialize()),
    failures,
    saturated: false,
    nextNoteOffset
  };
}
