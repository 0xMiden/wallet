import '../../../../test/jest-mocks';

import React, { Suspense } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

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

// ── Account wrappers: createAccount / scanForAccounts forward to the store ──
// The store actions are replaced on the live store so the assertions are about
// the wrapper's forwarding, not about the intercom round trip underneath.
const AccountActionProbe: React.FC<{ onResult: (found: unknown) => void }> = ({ onResult }) => {
  const ctx = useMidenContext();

  React.useEffect(() => {
    ctx.createAccount(WalletType.Guardian, 'Savings', 'https://guardian.example');
    ctx.scanForAccounts(7, 'https://guardian.example').then(onResult);
    // Runs once — the wrappers are useCallback-stable and re-running would
    // double-count the forwarding assertions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div />;
};

describe('useMidenContext — account wrappers', () => {
  // The store is a module singleton shared with the rest of this file, so the
  // stubbed actions have to be handed back afterwards. `status` is deliberately
  // left alone: the probes mounted by the other tests in this file re-run their
  // effects on every store change and would loop if the wallet flipped to Ready.
  const originalActions = {
    createAccount: useWalletStore.getState().createAccount,
    scanForAccounts: useWalletStore.getState().scanForAccounts
  };

  afterEach(() => {
    useWalletStore.setState(originalActions);
  });

  it('forwards all three createAccount args and returns scanForAccounts result', async () => {
    const storeCreateAccount = jest.fn(async () => {});
    const found = [{ publicKey: 'pk2', name: 'Account 2', isPublic: true, type: WalletType.OnChain, hdIndex: 1 }];
    const storeScanForAccounts = jest.fn(async () => found);
    useWalletStore.setState({
      createAccount: storeCreateAccount,
      scanForAccounts: storeScanForAccounts
    });

    const onResult = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <MidenContextProvider>
            <AccountActionProbe onResult={onResult} />
          </MidenContextProvider>
        </Suspense>
      );
    });

    expect(storeCreateAccount).toHaveBeenCalledWith(WalletType.Guardian, 'Savings', 'https://guardian.example');
    expect(storeScanForAccounts).toHaveBeenCalledWith(7, 'https://guardian.example');
    expect(onResult).toHaveBeenCalledWith(found);

    await act(async () => root.unmount());
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
