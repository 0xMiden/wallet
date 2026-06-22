import { IntercomClient } from 'lib/intercom';
import { request } from 'lib/miden/front/client';
import { WalletMessageType, WalletStatus, GetStateResponse } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

export const PASSWORD = 'pw';
export const MNEMONIC = 'test test test test test test test test test test test test';

export async function getState() {
  const res = (await request({
    type: WalletMessageType.GetStateRequest
  })) as GetStateResponse;
  return res.state;
}

export async function waitForStateUpdate(action?: () => Promise<any>) {
  const client = new IntercomClient();
  const stateUpdateReceived = new Promise<void>(resolve => {
    const unsubscribe = client.subscribe(msg => {
      if (msg?.type === WalletMessageType.StateUpdated) {
        unsubscribe();
        resolve();
      }
    });
  });

  if (action) {
    await action();
  }

  await stateUpdateReceived;
}

export async function ensureWalletReady() {
  const state = await getState();
  switch (state.status) {
    case WalletStatus.Ready:
      return state;
    case WalletStatus.Locked:
      await waitForStateUpdate(() =>
        request({
          type: WalletMessageType.UnlockRequest,
          password: PASSWORD
        })
      );
      return getState();
    case WalletStatus.Idle:
    default:
      await waitForStateUpdate(() =>
        request({
          type: WalletMessageType.NewWalletRequest,
          password: PASSWORD,
          mnemonic: MNEMONIC,
          ownMnemonic: true,
          walletType: WalletType.OffChain
        })
      );
      return getState();
  }
}
