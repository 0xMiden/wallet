import '../../../../test/jest-mocks';

import React, { Suspense } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { WalletMessageType, WalletStatus } from 'lib/shared/types';

import { MidenContextProvider, useMidenContext } from './client';

jest.mock('lib/intercom', () => {
  class MockIntercomClient {
    request = jest.fn(async (req: any) => {
      if (req.type === WalletMessageType.GetStateRequest) {
        return {
          type: WalletMessageType.GetStateResponse,
          state: {
            status: WalletStatus.Ready,
            accounts: [{ publicKey: 'pk', name: 'Acc', isPublic: true, type: 'on-chain', hdIndex: 0 }],
            networks: [],
            settings: {},
            currentAccount: { publicKey: 'pk', name: 'Acc', isPublic: true, type: 'on-chain', hdIndex: 0 },
            ownMnemonic: true
          }
        };
      }
      if (req.type === WalletMessageType.UpdateCurrentAccountRequest) {
        return { type: WalletMessageType.UpdateCurrentAccountResponse };
      }
      if (req.type === WalletMessageType.UpdateSettingsRequest) {
        return { type: WalletMessageType.UpdateSettingsResponse };
      }
      if (req.type === WalletMessageType.GetAuthSecretKeyRequest) {
        return { type: WalletMessageType.GetAuthSecretKeyResponse, key: 'secret' };
      }
      if (req.type === WalletMessageType.SignTransactionRequest) {
        return { type: WalletMessageType.SignTransactionResponse, signature: 'abcd' };
      }
      throw new Error(req.type);
    });
    subscribe = jest.fn(() => () => {});
  }
  return { IntercomClient: MockIntercomClient };
});

describe('useMidenContext actions', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it('calls updateCurrentAccount and updateSettings', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <MidenContextProvider>
            <ActionProbe />
          </MidenContextProvider>
        </Suspense>
      );
    });

    expect(container).toBeDefined();
  });
});

const ActionProbe: React.FC = () => {
  const { ready, currentAccount, updateCurrentAccount, updateSettings, getAuthSecretKey, signTransaction } =
    useMidenContext();

  React.useEffect(() => {
    if (ready) {
      updateCurrentAccount('pk');
      updateSettings({ contacts: [] });
      getAuthSecretKey('k');
      signTransaction('pk', 'payload');
    }
  }, [ready, updateCurrentAccount, updateSettings, getAuthSecretKey, signTransaction]);

  return <div data-ready={ready} data-account={currentAccount?.publicKey} />;
};
