import { expect, type Page } from '@playwright/test';

import { captureBaseline, expectWritesToTheEnd, type WriteResult, type WriteSide } from './dapp-assertions';
import { offchainDappAxis } from './dapp-axis';
import { HarnessFault, InfrastructureFault, type CellContext } from './dapp-cells';
import { canonicalAddress, normalizeHex } from './dapp-gates';
import type { AccountSlot, Journey } from './dapp-journey';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import {
  answerPrompt,
  callDapp,
  pendingNotes,
  popupBlock,
  setAutoConsume,
  unwrap,
  type DappHandle,
  type PendingNote,
  type PromptPlan
} from './test-dapp';
import type { NoteTypeName, Outcome, OutputSpec, RawArg } from '../test-dapp/protocol';

/**
 * Shared write recipes: each starts a dApp request, answers its popup and asserts it to the end, so a spec cell names
 * what it writes and nothing about how a write is checked.
 */

/** The executing side of a write: wallet A's account in `slot`, as the given dApp is connected to it. */
export async function sideOf(j: Journey, dapp: DappHandle, slot: AccountSlot = 'primary'): Promise<WriteSide> {
  const view = await callDapp(dapp, 'session', {});
  if (view.connected === null) throw new HarnessFault(`dApp ${dapp.label} is not connected`);
  return {
    wallet: j.walletA,
    dapp,
    axis: j.axis,
    account: await j.account(slot),
    accountIdHex: view.connected.accountIdHex,
    nativeFaucetId: j.nativeFaucetId
  };
}

export interface DappSend {
  amount: bigint;
  noteType: NoteTypeName;
  /**
   * `wire` sends `requestTransaction({ type: 'send' })` through the raw provider: the adapter routes send and consume
   * client-side (adapter.js:118-124), so only this reaches the wallet's own routing (dapp.ts:1761-1775).
   */
  via: 'requestSend' | 'requestTransaction' | 'wire';
  recallBlocks?: number;
  slot?: AccountSlot;
  /** Runs after the baseline and before the request (S9 locks the wallet here). */
  beforeRequest?: () => Promise<void>;
}

async function wireSend(
  j: Journey,
  dapp: DappHandle,
  send: DappSend,
  ctx: CellContext
): Promise<Outcome<{ txId: string }>> {
  const view = await callDapp(dapp, 'session', {}, ctx.deadline);
  if (view.connected === null) throw new HarnessFault(`dApp ${dapp.label} is not connected`);
  const payload: RawArg = {
    senderAddress: view.connected.addressCanonical,
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    noteType: send.noteType,
    amount: Number(send.amount),
    ...(send.recallBlocks === undefined ? {} : { recallBlocks: send.recallBlocks })
  };
  const answer = await callDapp(
    dapp,
    'raw',
    { call: 'requestTransaction', args: [{ type: 'send', payload }] },
    ctx.deadline
  );
  if (!answer.ok) return answer;
  const txId: unknown =
    typeof answer.value === 'object' && answer.value !== null ? Reflect.get(answer.value, 'transactionId') : undefined;
  if (typeof txId !== 'string')
    throw new HarnessFault(`requestTransaction(send) answered ${JSON.stringify(answer.value)}`);
  return { ok: true, value: { txId } };
}

/** A wallet-built send to B (P1b: one block passes with the popup open), asserted to the end. */
export async function dappSendToTheEnd(
  j: Journey,
  dapp: DappHandle,
  send: DappSend,
  ctx: CellContext,
  prompt: Partial<PromptPlan> = {}
): Promise<WriteResult> {
  const side = await sideOf(j, dapp, send.slot);
  const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
  await send.beforeRequest?.();
  const { result } = await answerPrompt(
    dapp,
    () =>
      send.via === 'wire'
        ? wireSend(j, dapp, send, ctx)
        : callDapp(
            dapp,
            'send',
            {
              recipientAddress: j.addressB,
              faucetId: j.tokenFaucetId,
              amount: send.amount.toString(),
              noteType: send.noteType,
              via: send.via,
              ...(send.recallBlocks === undefined ? {} : { recallBlocks: send.recallBlocks })
            },
            ctx.deadline
          ),
    {
      kind: 'transaction',
      decision: 'approve',
      origin: dapp.origin,
      whileOpen: () => popupBlock(dapp, ctx),
      ...prompt
    },
    ctx
  );
  const { txId } = unwrap(result, send.via, ctx);
  const [written] = await expectWritesToTheEnd(
    side,
    baseline,
    [
      {
        txId,
        outputNotes: [
          { noteType: send.noteType, recipient: { wallet: j.walletB, faucetId: j.tokenFaucetId, amount: send.amount } }
        ],
        consumedNullifiers: []
      }
    ],
    { [j.tokenFaucetId]: -send.amount },
    ctx
  );
  if (written === undefined) throw new HarnessFault('expectWritesToTheEnd returned no result');
  // The recall is all W3 adds to a send, and no step above reads it: the adapter routes a recallable send to the same
  // requestSend as any other (adapter.js:118-124).
  const script = send.recallBlocks === undefined ? 'p2id' : 'p2ide';
  expect(
    written.outputNotes.map(note => note.script),
    'output note script'
  ).toEqual([script]);
  return written;
}

export interface ProducedNote {
  noteId: string;
  bytesB64: string;
  nullifierHex: string;
  amount: bigint;
  faucetId: string;
}

/**
 * Wallet B's dApp builds a custom request with these outputs and submits it with no recipient, so the wallet relays
 * nothing (complete.ts:114-122) and A never receives the notes; B's waitForTransaction hands back their bytes, as a
 * dApp backend would hold them. It is B's write, single-sig, and it is checked to the end like any other.
 */
export async function produceNotesFromB(
  j: Journey,
  outputs: readonly OutputSpec[],
  ctx: CellContext
): Promise<ProducedNote[]> {
  const dappB = await j.dappB();
  const view = await callDapp(dappB, 'session', {}, ctx.deadline);
  if (view.connected === null) throw new HarnessFault("B's dApp is not connected");
  // B is single-sig on every leg (spec section 3), so its write settles and is checked as one, whatever A's axis.
  const side: WriteSide = {
    wallet: j.walletB,
    dapp: dappB,
    axis: offchainDappAxis,
    account: j.addressB,
    accountIdHex: view.connected.accountIdHex,
    nativeFaucetId: j.nativeFaucetId
  };
  const delta: Record<string, bigint> = {};
  for (const output of outputs) {
    for (const asset of [{ faucetId: output.faucetId, amount: output.amount }, ...(output.extraAssets ?? [])]) {
      delta[asset.faucetId] = (delta[asset.faucetId] ?? 0n) - BigInt(asset.amount);
    }
  }
  const baseline = await captureBaseline(side, Object.keys(delta), ctx);
  const built = await callDapp(dappB, 'buildCustom', { shape: 'p2id', outputs: [...outputs] }, ctx.deadline);
  const { result } = await answerPrompt(
    dappB,
    () =>
      callDapp(
        dappB,
        'submitCustom',
        { requestId: built.requestId, recipientAddress: '', importNotes: false },
        ctx.deadline
      ),
    { kind: 'transaction', decision: 'approve', origin: dappB.origin },
    ctx
  );
  const { txId } = unwrap(result, "B's producer request", ctx);
  const [written] = await expectWritesToTheEnd(
    side,
    baseline,
    [
      {
        txId,
        outputNotes: built.outputNoteIds.map((noteId, index) => ({
          noteId,
          noteType: outputs[index]?.noteType ?? 'private'
        })),
        consumedNullifiers: []
      }
    ],
    delta,
    ctx
  );
  if (written === undefined) throw new HarnessFault('the producer write returned no result');
  const notes: ProducedNote[] = [];
  for (const [index, noteId] of built.outputNoteIds.entries()) {
    const out = written.outputNotes.find(note => normalizeHex(note.noteId) === normalizeHex(noteId));
    const spec = outputs[index];
    if (out === undefined || spec === undefined) {
      throw new HarnessFault(`B's waitForTransaction did not return note ${noteId}`);
    }
    // From the bytes the wallet returned, not the page's build: a consume cell checks the note B's wallet wrote.
    const facts = await callDapp(dappB, 'noteFacts', { noteBytesB64: out.bytesB64 }, ctx.deadline);
    notes.push({
      noteId,
      bytesB64: out.bytesB64,
      nullifierHex: facts.nullifierHex,
      amount: BigInt(spec.amount),
      faucetId: spec.faucetId
    });
  }
  return notes;
}

/** One discovered, unconsumed note of the current account, or null. */
export async function pendingNote(page: Page, noteId: string): Promise<PendingNote | null> {
  return (await pendingNotes(page)).find(note => normalizeHex(note.id) === normalizeHex(noteId)) ?? null;
}

/**
 * A public note of the network's native asset to `address`: a grant from the network's public faucet, returned once
 * it is on chain. The faucet can accept a grant and never commit its note, so the commit wait is part of the grant,
 * and either failing is the environment's (spec section 6), never the wallet's.
 */
export async function nativeNoteTo(j: Journey, address: string): Promise<{ noteId: string }> {
  const faucet = publicFaucetApiUrl(j.env.name);
  if (faucet === undefined) throw new InfrastructureFault(`no public faucet for ${j.env.name}`);
  try {
    const { noteId } = await mintFromPublicFaucet(faucet, canonicalAddress(address));
    await waitForPublicNoteCommitment(j.env.rpcUrl, noteId);
    return { noteId };
  } catch (error) {
    throw new InfrastructureFault(
      `Public faucet grant failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Wallet A's delegated-proving setting, put back on by the cell's restore. */
export async function setDelegatedProving(j: Journey, enabled: boolean): Promise<void> {
  j.touch('delegate');
  await j.walletA.setDelegateProofEnabled(enabled);
}

/** Auto-consume off in wallet A until the cell's restore, so a native-asset note waits for the dApp's consume. */
export async function turnAutoConsumeOff(j: Journey): Promise<void> {
  j.touch('autoConsume');
  await setAutoConsume(j.walletA, false);
}
