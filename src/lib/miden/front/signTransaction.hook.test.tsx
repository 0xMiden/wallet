import '../../../../test/jest-mocks';

import React, { Suspense, useEffect } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { MidenContextProvider, useMidenContext } from 'lib/miden/front/client';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';

jest.mock('../sdk/miden-client', () => jest.requireActual('../../../../__mocks__/lib/miden/sdk/miden-client'));

const mockIntercomClient = {
  request: jest.fn(async (req: any) => {
    if (req.type === WalletMessageType.GetStateRequest) {
      return {
        type: WalletMessageType.GetStateResponse,
        state: {
          status: WalletStatus.Ready,
          accounts: [{ publicKey: 'miden-account-1', name: 'Acc', isPublic: true, type: 'on-chain', hdIndex: 0 }],
          networks: [],
          settings: {},
          currentAccount: { publicKey: 'miden-account-1', name: 'Acc', isPublic: true, type: 'on-chain', hdIndex: 0 },
          ownMnemonic: true
        }
      };
    }
    if (req.type === WalletMessageType.SignTransactionRequest) {
      return {
        type: WalletMessageType.SignTransactionResponse,
        signature: 'abcd'
      };
    }
    throw new Error(`Unhandled request ${req.type}`);
  }),
  subscribe: jest.fn(() => () => {})
};

jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => mockIntercomClient),
  IntercomClient: jest.fn().mockImplementation(() => mockIntercomClient)
}));

// Reset store state before each test
beforeEach(() => {
  useWalletStore.setState({
    status: WalletStatus.Idle,
    accounts: [],
    currentAccount: null,
    networks: [],
    settings: null,
    ownMnemonic: null,
    assetsMetadata: {},
    selectedNetworkId: null,
    confirmation: null,
    isInitialized: false,
    isSyncing: false,
    lastSyncedAt: null
  });
});

describe('useMidenContext signTransaction', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('returns Uint8Array signature bytes from hex string', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    const result = new Promise<Uint8Array>(async resolve => {
      const Probe: React.FC = () => {
        const { ready, signTransaction } = useMidenContext();

        useEffect(() => {
          if (!ready) return;
          signTransaction('miden-account-1', 'payload').then(sig => resolve(sig));
        }, [ready, signTransaction]);

        return null;
      };

      await act(async () => {
        root.render(
          <Suspense fallback={null}>
            <WalletStoreProvider>
              <MidenContextProvider>
                <Probe />
              </MidenContextProvider>
            </WalletStoreProvider>
          </Suspense>
        );
      });
    });

    const sigBytes = await result;
    expect(sigBytes).toEqual(Uint8Array.from([0xab, 0xcd]));

    act(() => {
      root.unmount();
    });
  });
});
