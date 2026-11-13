import { useMidenContext } from 'lib/miden/front';
import { isExtension } from 'lib/platform';
import { getPlatformUnlockSupport } from 'lib/platform-auth/capabilities';
import type { PlatformUnlockState } from 'lib/platform-auth/types';
import { signalUnknownPlatformCredential } from 'lib/platform-auth/webauthn';
import type { WalletActions } from 'lib/store/types';
import { useRetryableSWR } from 'lib/swr';

const unavailable: PlatformUnlockState = { available: false, hasPassword: false, credential: null };

async function signalPending(send: WalletActions['platformUnlock']): Promise<void> {
  try {
    const pending = await send({ action: 'pending-signals' });
    if (pending.action !== 'pending-signals') return;
    for (const credentialId of pending.credentialIds) {
      try {
        await signalUnknownPlatformCredential(credentialId);
        await send({ action: 'signal-complete', credentialId });
      } catch {
        // Provider cleanup is best-effort; leave failed IDs in the worker's durable journal.
      }
    }
  } catch {
    // An unavailable worker must not block password recovery.
  }
}

export function usePlatformUnlock() {
  const { platformUnlock } = useMidenContext();
  const { data, error, isLoading, mutate } = useRetryableSWR<PlatformUnlockState, Error>(
    isExtension() ? 'platform-unlock-state' : null,
    async () => {
      if (!(await getPlatformUnlockSupport())) return unavailable;
      const result = await platformUnlock({ action: 'state' });
      if (result.action !== 'state') throw new Error('Invalid platform state response');
      void signalPending(platformUnlock);
      return result.state;
    },
    { suspense: false, shouldRetryOnError: false }
  );
  return { state: error ? unavailable : (data ?? unavailable), loading: isLoading, refresh: mutate };
}
