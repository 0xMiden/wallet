// The node reads one reconciler pass makes (#1081): one standalone RpcClient on the effective endpoint, built for the
// pass and used for every read in it, taking no WASM client lock (as `readChainAccountCommitment` reads). Nothing is
// cached across passes, so a same-URL reset or a retarget is caught by the next pass's network check. Every read is
// bounded and never throws to its caller: a failed read means no verdict this pass.
import { NoteId, RpcClient, Word } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { RpcTimeoutError, withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { accountRefToSdk } from '../sdk/helpers';
import { errorMessageParts } from '../sdk/sdk-error-code';
import { normalizeHex } from '../sdk/submit-evidence';

export const RPC_READ_TIMEOUT_MS = 15_000;
/** The commitment a non-inclusion witness carries: the account is absent at that block. */
export const ZERO_WORD = `0x${'0'.repeat(64)}`;
/** The fastest cadence the repo runs (local-e2e's 500 ms blocks): assumed until measured, it errs short. */
export const DEFAULT_CADENCE_MS = 500;

export interface AccountState {
  blockNum: number;
  /** Absent for a non-inclusion witness, which is not a commitment and never marks a pre-state as seen. */
  commitment?: string;
  /** Decimal; only when the proof carries a header, which private accounts (Guardian ones among them) never do. */
  nonce?: string;
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

let lastTip: { block: number; atMs: number } | undefined;
let cadenceMs: number | undefined;

/** Feed one tip read into the realm's cadence: the time per block between two reads at different heights. */
export const observeTip = (block: number, atMs: number): void => {
  if (lastTip !== undefined && block > lastTip.block) cadenceMs = (atMs - lastTip.atMs) / (block - lastTip.block);
  if (lastTip === undefined || block > lastTip.block) lastTip = { block, atMs };
};

export const observedCadenceMs = (): number => cadenceMs ?? DEFAULT_CADENCE_MS;

export const __resetCadenceForTests = (): void => {
  lastTip = undefined;
  cadenceMs = undefined;
};

const once = <T>(read: () => Promise<T>, label: string, timeoutMs: number): Promise<T> =>
  withRpcTimeout(read, `unconfirmed reconcile: ${label}`, { timeoutMs, retries: 0 });

export async function createNodeReads(): Promise<NodeReads> {
  await ensureSdkWasmReady();
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
      try {
        const proof = await once(
          () => client.getAccountProof(accountRefToSdk(accountId), null, atBlock ?? null),
          'account',
          timeoutMs
        );
        const blockNum = proof.blockNum();
        if (atBlock === undefined) observeTip(blockNum, Date.now());
        const commitment = normalizeHex(proof.accountCommitment().toHex());
        let nonce: string | undefined;
        try {
          nonce = proof.accountHeader()?.nonce().asInt().toString();
        } catch {
          nonce = undefined;
        }
        const state: AccountState = { blockNum };
        if (commitment !== ZERO_WORD) state.commitment = commitment;
        if (nonce !== undefined) state.nonce = nonce;
        return { ok: true, state };
      } catch (error) {
        // The node keeps about 50 blocks of account history; past it the read can only fail.
        return {
          ok: false,
          pruned: errorMessageParts(error).some(part => /has been pruned/i.test(part)),
          timedOut: error instanceof RpcTimeoutError
        };
      }
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
