export enum SwapFlowStep {
  SwapAmounts = 'SwapAmounts',
  ReviewSwap = 'ReviewSwap'
}

/** Which side of the swap a token picker / amount edit applies to. */
export type SwapSide = 'offer' | 'request';
