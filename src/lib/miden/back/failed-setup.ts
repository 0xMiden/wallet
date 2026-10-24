import { clearStorage } from 'lib/miden/reset';

/**
 * The one undo routine for every failed wallet setup: a spawn whose creation rejected after
 * its opening wipe, or one that resolved but was never published. Retires the vault's
 * provisional realm sink before the clear removes the keys that fed it, clears down to what
 * every setup keeps, and never touches the device's hardware key (one per install, not per
 * vault). Never throws: every caller runs this from a catch or a finally, where a throw here
 * would replace or mask the real failure it is undoing.
 */
export async function undoFailedSetup(vault: { retire(): void } | undefined, caller: string): Promise<void> {
  vault?.retire();
  await clearStorage(false).catch(undoError => console.error(`[${caller}] could not undo a failed setup:`, undoError));
}
