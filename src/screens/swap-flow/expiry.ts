/**
 * The swap order's expiry: four presets on the review, inside a range the wallet sets itself.
 *
 * WHAT EXPIRY ACTUALLY IS HERE. `expirySeconds` never reaches the SDK: `swapTransaction`
 * builds the PSWAP note from the two faucets and amounts alone, so the protocol enforces no
 * deadline of its own. What the number does is stamp `extraInputs.expiresAt` at completion
 * (`transaction/complete.ts`), which is the moment `reconcileSwapOrderNotes`
 * (`lib/miden/swap/settlement.ts`) stops waiting for a fill and reclaims the offered tip back
 * into the wallet. So the bounds below are the wallet's own, not the chain's; there is no
 * protocol maximum to read off.
 *
 * MINIMUM, 30 seconds. Below that the order can expire before the settlement tick has had a
 * chance to see a fill at all, so the reclaim would race the solver that is filling it.
 *
 * MAXIMUM, 7 days. Until it expires the offered asset sits in a public note that any solver
 * may fill at the rate quoted when it was placed, so the cap is really "how long is it
 * reasonable to leave a stale quote standing". A week is a round, conservative answer that
 * still covers leaving an order out over a holiday; it is a product choice, not a chain limit,
 * and it can be raised without touching anything downstream.
 *
 * The review offers only the presets, all inside that range; SwapManager's submit gate still
 * checks the seconds it is handed against the bounds.
 */

export const MIN_EXPIRY_SECONDS = 30;
export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Is this a value the flow may submit? Whole seconds, inside the wallet's own range. */
export const isValidExpirySeconds = (seconds: number): boolean =>
  Number.isInteger(seconds) && seconds >= MIN_EXPIRY_SECONDS && seconds <= MAX_EXPIRY_SECONDS;

export type ExpiryPresetId = '2m' | '1h' | '1d' | '7d';

/**
 * The review's four choices, from the default up to the cap: how long the wallet waits for a fill
 * before it cancels the order and takes the offer back.
 */
export const EXPIRY_PRESETS: readonly { id: ExpiryPresetId; seconds: number; labelKey: string }[] = [
  { id: '2m', seconds: 2 * 60, labelKey: 'swapExpiryPreset2Min' },
  { id: '1h', seconds: 60 * 60, labelKey: 'swapExpiryPreset1Hour' },
  { id: '1d', seconds: 24 * 60 * 60, labelKey: 'swapExpiryPreset1Day' },
  { id: '7d', seconds: MAX_EXPIRY_SECONDS, labelKey: 'swapExpiryPreset7Days' }
];

/** The preset these seconds are, or the closest one for a value from elsewhere. */
export const presetForSeconds = (seconds: number) =>
  EXPIRY_PRESETS.reduce((best, preset) =>
    Math.abs(preset.seconds - seconds) < Math.abs(best.seconds - seconds) ? preset : best
  );
