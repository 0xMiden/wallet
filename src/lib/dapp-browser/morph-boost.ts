/** How long a touch-down request holds the full frame rate when no morph takes it over. */
export const MORPH_PREPARE_MS = 600;

export function prepareMorph(): Promise<void> {
  return Promise.resolve();
}
