// The node reads one reconciler pass makes (#1081): one standalone RpcClient on the effective endpoint, built for the
// pass and used for every read in it, taking no WASM client lock (as `readChainAccountCommitment` reads). No read is
// cached across passes, so a same-URL reset or a retarget is caught by the next pass's network check; only the block
// cadence outlives a pass, and it belongs to the endpoint it was measured on. Every read is bounded and never throws
// to its caller: a failed read means no verdict this pass.
import { NoteId, RpcClient, Word } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { RpcTimeoutError, withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { accountRefToSdk, canonicalWalletAccountId } from '../sdk/helpers';
import { errorMessageParts } from '../sdk/sdk-error-code';
import { normalizeHex } from '../sdk/submit-evidence';

export const RPC_READ_TIMEOUT_MS = 15_000;
/** The commitment a non-inclusion witness carries: the account is absent at that block. */
export const ZERO_WORD = `0x${'0'.repeat(64)}`;
/** The fastest cadence the repo runs (local-e2e's 500 ms blocks): assumed until measured, it errs short. */
export const DEFAULT_CADENCE_MS = 500;

export interface AccountState {
  blockNum: number;
  /** Absent for an account absent at that block, which has no commitment and never marks a pre-state as seen. */
  commitment?: string;
  /** Decimal; only when the proof carries a header, which private accounts (Guardian ones among them) never do. */
  nonce?: string;
  /** The absence came from the node's "not found at block N" answer rather than a non-inclusion witness. */
  notFound?: boolean;
}

/** A failed read says whether the node pruned that block, and whether the read ran out its own timeout. */
export type AccountRead = { ok: true; state: AccountState } | { ok: false; pruned: boolean; timedOut: boolean };

export interface NodeReads {
  blockCommitment(blockNum: number): Promise<string | undefined>;
  account(accountId: string, atBlock: number | undefined, timeoutMs: number): Promise<AccountRead>;
  noteInclusions(noteIds: readonly string[], timeoutMs: number): Promise<ReadonlyMap<string, number> | undefined>;
  /** The block that spent `nullifier` at or after `fromBlock`, null when unspent, undefined when the read failed. */
  nullifierHeight(nullifier: string, fromBlock: number, timeoutMs: number): Promise<number | null | undefined>;
}

let lastTip: { scope: string; block: number; atMs: number } | undefined;
let cadenceMs: number | undefined;

/**
 * Feed one tip read into the realm's cadence: the time per block between two reads at different heights of the node
 * at `scope`, with `atMs` on a monotonic clock. Another endpoint, or a lower tip (a node reset on the same URL),
 * starts the measurement over, since another chain's blocks come at another pace.
 */
export const observeTip = (block: number, atMs: number, scope: string = getEffectiveRpcUrl()): void => {
  const last = lastTip;
  if (last !== undefined && last.scope === scope && block === last.block) return;
  // No chain the wallet runs on is faster than the default, so a shorter pace is noise, such as two reads milliseconds
  // apart on either side of one block.
  cadenceMs =
    last !== undefined && last.scope === scope && block > last.block
      ? Math.max(DEFAULT_CADENCE_MS, (atMs - last.atMs) / (block - last.block))
      : undefined;
  lastTip = { scope, block, atMs };
};

export const observedCadenceMs = (): number =>
  cadenceMs !== undefined && lastTip?.scope === getEffectiveRpcUrl() ? cadenceMs : DEFAULT_CADENCE_MS;

export const __resetCadenceForTests = (): void => {
  lastTip = undefined;
  cadenceMs = undefined;
};

const NOT_FOUND_AT_BLOCK = /\baccount (\S+) not found at block (\d+)\b/;

/** The block a "not found" answer names, only when it names `accountId`: one about another account says nothing. */
const absentAtBlock = (parts: readonly string[], accountId: string): number | undefined => {
  const wanted = normalizeHex(canonicalWalletAccountId(accountId));
  for (const part of parts) {
    const [, id, block] = NOT_FOUND_AT_BLOCK.exec(part) ?? [];
    if (id !== undefined && block !== undefined && normalizeHex(id) === wanted) return Number(block);
  }
  return undefined;
};

const once = <T>(read: () => Promise<T>, label: string, timeoutMs: number): Promise<T> =>
  withRpcTimeout(read, `unconfirmed reconcile: ${label}`, { timeoutMs, retries: 0 });

export async function createNodeReads(): Promise<NodeReads> {
  await ensureSdkWasmReady();
  // Taken in the same tick the client is built in, so a tip read is credited to the node that answered it.
  const scope = getEffectiveRpcUrl();
  const client = new RpcClient(getRpcEndpoint());
  return {
    blockCommitment: async blockNum => {
      try {
        const header = await once(
          () => client.getBlockHeaderByNumber(blockNum, false),
          'block header',
          RPC_READ_TIMEOUT_MS
        );
        return normalizeHex(header.commitment().toHex());
      } catch (error) {
        console.warn(`[reconcile] could not read the header of block ${blockNum}`, error);
        return undefined;
      }
    },
    account: async (accountId, atBlock, timeoutMs) => {
      let state: AccountState;
      try {
        const proof = await once(
          () => client.getAccountProof(accountRefToSdk(accountId), null, atBlock ?? null),
          'account',
          timeoutMs
        );
        state = { blockNum: proof.blockNum() };
        const commitment = normalizeHex(proof.accountCommitment().toHex());
        if (commitment !== ZERO_WORD) state.commitment = commitment;
        try {
          const nonce = proof.accountHeader()?.nonce().asInt().toString();
          if (nonce !== undefined) state.nonce = nonce;
        } catch {
          // An unreadable header only withholds the nonce; the commitment it came with still stands.
        }
      } catch (error) {
        const parts = errorMessageParts(error);
        // The node keeps about 50 blocks of account history; past it the read can only fail.
        const pruned = parts.some(part => /has been pruned/i.test(part));
        // A public account's read asks for its details, and the node answers an account with no header row at or
        // before N with "account <id> not found at block N" instead of a non-inclusion witness. Node 0.16 never prunes
        // header rows, so that answer proves the account absent at N; the judge takes it only for a deploy.
        const absentAt = pruned ? undefined : absentAtBlock(parts, accountId);
        if (absentAt === undefined) {
          console.warn(`[reconcile] could not read account ${accountId} at block ${atBlock ?? 'tip'}`, error);
          return { ok: false, pruned, timedOut: error instanceof RpcTimeoutError };
        }
        state = { blockNum: absentAt, notFound: true };
      }
      // A wall clock can step back between two reads; the monotonic one cannot.
      if (atBlock === undefined) observeTip(state.blockNum, performance.now(), scope);
      return { ok: true, state };
    },
    noteInclusions: async (noteIds, timeoutMs) => {
      try {
        // NoteIds are moved by the call, so each read builds its own handles.
        const fetched = await once(
          () => client.getNotesById(noteIds.map(id => NoteId.fromHex(id))),
          'notes',
          timeoutMs
        );
        const blocks = new Map<string, number>();
        for (const note of fetched)
          blocks.set(normalizeHex(note.noteId.toString()), note.inclusionProof.location().blockNum());
        return blocks;
      } catch (error) {
        console.warn('[reconcile] could not read output notes', error);
        return undefined;
      }
    },
    nullifierHeight: async (nullifier, fromBlock, timeoutMs) => {
      try {
        const height = await once(
          () => client.getNullifierCommitHeight(Word.fromHex(nullifier), fromBlock),
          'nullifier',
          timeoutMs
        );
        return height ?? null;
      } catch (error) {
        console.warn('[reconcile] could not read a nullifier height', error);
        return undefined;
      }
    }
  };
}
