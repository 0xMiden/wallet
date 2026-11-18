import { SW_TARGET } from 'lib/miden/back/offscreen-codec';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { u8ToB64 } from 'lib/shared/helpers';

import { markWalletStorageUnavailable } from '../storage-health';

export const OFFSCREEN_RETAIN_RECOVERY_NOTES = 'OFFSCREEN_RETAIN_RECOVERY_NOTES';
export const OFFSCREEN_STORAGE_FAILURE = 'OFFSCREEN_STORAGE_FAILURE';

function inOffscreenDocument(): boolean {
  return (
    typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id) && globalThis.location?.pathname === '/offscreen.html'
  );
}

export async function reportSdkStorageFailure(): Promise<void> {
  if (inOffscreenDocument()) {
    try {
      if ((await chrome.runtime.sendMessage({ target: SW_TARGET, type: OFFSCREEN_STORAGE_FAILURE })) === true) return;
    } catch {
      // The client must still stop if the background page cannot answer.
    }
  }
  await markWalletStorageUnavailable();
}

export async function retainIncomingNotes(batch: { notes: readonly Uint8Array[] }, rpc: string): Promise<void> {
  if (getEffectiveRpcUrl() !== rpc) throw new Error('The wallet network changed');
  const notes = batch.notes.map(u8ToB64);
  if (inOffscreenDocument()) {
    const response: unknown = await chrome.runtime.sendMessage({
      target: SW_TARGET,
      type: OFFSCREEN_RETAIN_RECOVERY_NOTES,
      scope: rpc,
      notes
    });
    if (response !== true) throw new Error('Wallet recovery data could not be saved');
    return;
  }
  const { retainWalletNotes } = await import('../back/storage-recovery');
  await retainWalletNotes(notes, rpc);
}
