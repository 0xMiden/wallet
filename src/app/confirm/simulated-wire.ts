import { serializeBigints } from 'lib/intercom/helpers';

import type { AssetAmount, TxAssetView } from './decode';
import type { NoteDetail, NoteFlow } from './note-flow';

/** An amount as a decimal string: a bigint does not survive every message channel's serialization. */
export interface WireAssetAmount {
  faucetId: string;
  amount: string;
}

/** The note lists stay behind: the sheet shows only the totals, and their bigint amounts would cross as strings. */
export type SimulatedViewWire = Omit<
  TxAssetView,
  'outgoing' | 'incoming' | 'fee' | 'viewConsumedNotes' | 'createdNotes'
> & {
  outgoing: WireAssetAmount[];
  incoming: WireAssetAmount[];
  fee?: WireAssetAmount;
};

export type NoteDetailWire = Omit<NoteDetail, 'assets'> & { assets?: WireAssetAmount[] };

export type NoteFlowWire = Omit<NoteFlow, 'inputs' | 'outputs'> & {
  inputs: NoteDetailWire[];
  outputs: NoteDetailWire[];
};

/** A dApp dry run's decoded effects as the approval window receives them. */
export interface SimulatedEffectsWire {
  view: SimulatedViewWire;
  noteFlow?: NoteFlowWire;
}

const DECIMAL_AMOUNT = /^\d+$/;

function amountFromWire({ faucetId, amount }: WireAssetAmount): AssetAmount {
  if (typeof amount !== 'string' || !DECIMAL_AMOUNT.test(amount)) throw new Error('malformed simulated effects');
  return { faucetId, amount: BigInt(amount) };
}

function noteFromWire({ assets, ...note }: NoteDetailWire): NoteDetail {
  return { ...note, ...(assets && { assets: assets.map(amountFromWire) }) };
}

export function toSimulatedEffectsWire(view: TxAssetView, noteFlow?: NoteFlow): SimulatedEffectsWire {
  const { viewConsumedNotes: _consumed, createdNotes: _created, ...shown } = view;
  return serializeBigints({ view: shown, noteFlow });
}

/** Throws on an amount that is not a non-negative decimal integer, so a malformed reply never renders as verified. */
export function fromSimulatedEffectsWire(wire: SimulatedEffectsWire): { view: TxAssetView; noteFlow?: NoteFlow } {
  const { outgoing, incoming, fee, ...rest } = wire.view;
  const { noteFlow } = wire;
  return {
    view: {
      ...rest,
      outgoing: outgoing.map(amountFromWire),
      incoming: incoming.map(amountFromWire),
      ...(fee && { fee: amountFromWire(fee) })
    },
    ...(noteFlow && {
      noteFlow: { ...noteFlow, inputs: noteFlow.inputs.map(noteFromWire), outputs: noteFlow.outputs.map(noteFromWire) }
    })
  };
}
