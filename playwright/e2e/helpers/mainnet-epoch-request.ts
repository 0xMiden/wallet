import type { MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

export interface EpochCollateralReview {
  currentBlock: number;
  reclaimHeight: number;
  bindingHash: string;
}

export function inspectEpochCollateralRequest(
  _state: MainnetEpochCheckpoint,
  _bytes: Uint8Array,
  _review: EpochCollateralReview
): { noteId: string; reclaimHeight: number } {
  return { noteId: '', reclaimHeight: 0 };
}
