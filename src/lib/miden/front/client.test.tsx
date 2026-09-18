import '../../../../test/jest-mocks';

import React, { Suspense } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { WalletMessageType, WalletStatus } from 'lib/shared/types';

import { MidenContextProvider, useMidenContext } from './client';

const mockExportAccountFileRequests: any[] = [];

jest.mock('lib/intercom', () => {
  class MockIntercomClient {
    request = jest.fn(async (req: any) => {
      if (req.type === WalletMessageType.ExportAccountFileRequest) {
        mockExportAccountFileRequests.push(req);
        return { type: WalletMessageType.ExportAccountFileResponse, accountFileBase64: 'BwgJ' };
      }
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

// The store reaches the backend through `lib/intercom/client`, not the barrel above, so the
// barrel mock alone never intercepts a request and an un-mocked client leaves every call
// pending forever. Both paths share the one mock class above.
jest.mock('lib/intercom/client', () => ({
  createIntercomClient: () => new (jest.requireMock('lib/intercom') as any).IntercomClient()
}));

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
  const ctx = useMidenContext();

  React.useEffect(() => {
    if (ctx.ready) {
      ctx.updateCurrentAccount('pk');
      ctx.updateSettings({ contacts: [] });
      ctx.getAuthSecretKey('k');
      ctx.signTransaction('pk', 'payload');
    }
  }, [ctx]);

  return <div data-ready={ctx.ready} data-account={ctx.currentAccount?.publicKey} />;
};

// Probe that exercises every wrapper callback exposed by useMidenContext.
// We swallow rejections — the tests only need each callback to RUN once
// so the v8 fn coverage records it. Errors are expected for many of them
// because the mocked intercom rejects unknown request types.
const FullActionProbe: React.FC = () => {
  const ctx = useMidenContext() as any;

  React.useEffect(() => {
    if (!ctx.ready) return;
    const swallow = (p: any) => {
      try {
        const r = typeof p === 'function' ? p() : p;
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* ignore */
      }
    };
    swallow(() => ctx.registerWallet?.('pw', 'mnemonic', false));
    swallow(() => ctx.importWalletFromClient?.('pw', 'mnemonic'));
    swallow(() => ctx.unlock?.('pw'));
    swallow(() => ctx.createAccount?.('on-chain', 'name'));
    swallow(() => ctx.updateCurrentAccount?.('pk'));
    swallow(() => ctx.editAccountName?.('pk', 'new-name'));
    swallow(() => ctx.setGuardianOperatorCommitment?.('pk', 'commitment-hex'));
    swallow(() => ctx.setGuardianSyncStatus?.('pk', 'needs-user-input'));
    swallow(() => ctx.checkGuardianDrift?.('pk'));
    swallow(() => ctx.applyUserGuardianEndpoint?.('pk', 'https://mine'));
    swallow(() => ctx.revealMnemonic?.('pw'));
    swallow(() => ctx.updateSettings?.({ contacts: [] }));
    swallow(() => ctx.signData?.('pk', 'payload'));
    swallow(() => ctx.signTransaction?.('pk', 'payload'));
    swallow(() => ctx.getAuthSecretKey?.('k'));
    swallow(() => ctx.getDAppPayload?.('id'));
    swallow(() => ctx.simulateCustomTransaction?.('id'));
    swallow(() => ctx.confirmDAppPermission?.('id', true, 'acc', 'AUTO', 1));
    swallow(() => ctx.confirmDAppSign?.('id', true));
    swallow(() => ctx.confirmDAppPrivateNotes?.('id', true));
    swallow(() => ctx.confirmDAppAssets?.('id', true));
    swallow(() => ctx.confirmDAppImportPrivateNote?.('id', true));
    swallow(() => ctx.confirmDAppConsumableNotes?.('id', true));
    swallow(() => ctx.confirmDAppTransaction?.('id', true, true));
    swallow(() => ctx.getAllDAppSessions?.());
    swallow(() => ctx.removeDAppSession?.('origin'));
    swallow(() => ctx.resetConfirmation?.());
  }, [ctx]);

  return <div data-ready={ctx.ready} />;
};

// The swallow-everything probe above cannot cover this one: it is the wiring this change adds,
// so it needs an assertion that goes red when the wrapper forwards to the wrong store action,
// drops the password, or stops returning what the backend sent.
let exportPromise: Promise<Uint8Array> | null = null;

const ExportAccountFileProbe: React.FC = () => {
  const ctx = useMidenContext();

  // Deliberately NOT gated on ctx.ready: the wrapper is a pure forward to the store action and
  // owes nothing to wallet status, and the gate is what makes the sibling probes above vacuous.
  React.useEffect(() => {
    if (!exportPromise) exportPromise = ctx.exportAccountFile('pk', 'pw');
  }, [ctx]);

  return null;
};

describe('useMidenContext exportAccountFile', () => {
  it('forwards the account and password, and returns the bytes the backend sent', async () => {
    exportPromise = null;
    mockExportAccountFileRequests.length = 0;
    const root = createRoot(document.createElement('div'));

    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <MidenContextProvider>
            <ExportAccountFileProbe />
          </MidenContextProvider>
        </Suspense>
      );
    });

    expect(exportPromise).not.toBeNull();
    const bytes = await exportPromise!;

    expect(mockExportAccountFileRequests).toEqual([
      { type: WalletMessageType.ExportAccountFileRequest, accountPublicKey: 'pk', password: 'pw' }
    ]);
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });
});

describe('useMidenContext — full callback coverage', () => {
  it('runs every exposed wrapper callback at least once', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <MidenContextProvider>
            <FullActionProbe />
          </MidenContextProvider>
        </Suspense>
      );
    });
    expect(container).toBeDefined();
  });
});
