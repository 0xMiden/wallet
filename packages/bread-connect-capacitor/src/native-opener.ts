import { BreadConnectNative, NativeOpenStep } from './plugin.js';

/** The request-owned sequence uses native destinations and never supplies a store URL. */
export async function openManagedWallet(link: string, signal: AbortSignal): Promise<boolean> {
  let attemptId: string | undefined;
  let revoked = false;
  const revoke = () => {
    if (attemptId === undefined || revoked) return;
    revoked = true;
    void BreadConnectNative.revokeOpen({ attemptId }).catch(() => undefined);
  };
  signal.addEventListener('abort', revoke, { once: true });
  try {
    attemptId = (await BreadConnectNative.prepareOpen({ url: link })).attemptId;
    if (signal.aborted) revoke();
    let step: NativeOpenStep | undefined = 'wallet';
    while (step !== undefined) {
      const result = await BreadConnectNative.openStep({ attemptId, step });
      if (result.cancelled || result.opened) return true;
      step = result.next;
    }
    return false;
  } finally {
    signal.removeEventListener('abort', revoke);
    revoke();
  }
}
