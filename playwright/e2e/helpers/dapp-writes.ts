import { captureBaseline, expectWritesToTheEnd, type WriteResult, type WriteSide } from './dapp-assertions';
import { HarnessFault, type CellContext } from './dapp-cells';
import type { AccountSlot, Journey } from './dapp-journey';
import { answerPrompt, callDapp, popupBlock, unwrap, type DappHandle, type PromptPlan } from './test-dapp';
import type { NoteTypeName, Outcome, RawArg } from '../test-dapp/protocol';

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
  return written;
}
