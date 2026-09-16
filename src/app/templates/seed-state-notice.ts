import { SeedPhraseStatus } from 'lib/shared/types';

/**
 * What a seed-gated screen says when the phrase is not 'stored'. One table, so
 * the two screens that report this state cannot drift apart.
 *
 * The three cases are genuinely different and a two-way split gets one of them
 * wrong: a wallet imported from a hot key has status 'unavailable' from birth
 * (see NewWalletFromHotKeyRequest) and never had a phrase on this device, so
 * telling that user it was "removed" is false.
 */
export const SEED_STATE_NOTICE: Record<Exclude<SeedPhraseStatus, 'stored'>, string> = {
  removing: 'seedRemovalIncomplete',
  removed: 'seedPhraseRemoved',
  unavailable: 'seedPhraseNotOnThisDevice'
};
