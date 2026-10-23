/**
 * AppKit's setup arms the startup reconnect bound from the status AppKit stored, and feeds it AppKit's account
 * status and modal state. The bound's own rules are tested in `startup-reconnect.test.ts`.
 */
import type { UseAppKitAccountReturn } from '@reown/appkit-controllers';

import { STARTUP_RECONNECT_BOUND_MS } from './startup-reconnect';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({ config: null }),
  ensureBridgeConfig: async () => ({ config: null }),
  initBridgeConfig: async () => ({ config: null }),
  subscribeBridgeConfig: () => () => {}
}));

type AccountListener = (account: UseAppKitAccountReturn) => void;
type Loaded = {
  modal: { disconnect: jest.Mock; subscribeAccount: jest.Mock };
  /** The storage mock of this load: an isolated load has its own, so the test reads that one. */
  storage: {
    setConnectionStatus: jest.Mock;
    deleteConnectedConnectorId: jest.Mock;
    removeConnectedNamespace: jest.Mock;
  };
  account: (status: UseAppKitAccountReturn['status']) => void;
  timedOut: () => boolean;
};

// A fresh page load with the given stored status.
async function load(stored: 'connected' | 'disconnected' | undefined): Promise<Loaded> {
  const loads: Loaded[] = [];
  await jest.isolateModulesAsync(async () => {
    const controllers = await import('@reown/appkit-controllers');
    const accountListeners: AccountListener[] = [];
    jest.mocked(controllers.StorageUtil.getConnectionStatus).mockReturnValue(stored);
    const createAppKitMock = jest.mocked((await import('@reown/appkit/react')).createAppKit);
    const base = createAppKitMock.getMockImplementation();
    if (base === undefined) throw new Error('the AppKit mock has no implementation');
    createAppKitMock.mockImplementationOnce(options => {
      const created = base(options);
      jest.mocked(created.subscribeAccount).mockImplementation((listener: AccountListener) => {
        accountListeners.push(listener);
        return () => {};
      });
      return created;
    });
    const { modal } = await import('./appkit');
    const { startupReconnectTimedOut } = await import('./startup-reconnect');
    loads.push({
      modal: { disconnect: jest.mocked(modal.disconnect), subscribeAccount: jest.mocked(modal.subscribeAccount) },
      storage: {
        setConnectionStatus: jest.mocked(controllers.StorageUtil.setConnectionStatus),
        deleteConnectedConnectorId: jest.mocked(controllers.StorageUtil.deleteConnectedConnectorId),
        removeConnectedNamespace: jest.mocked(controllers.StorageUtil.removeConnectedNamespace)
      },
      account: status =>
        accountListeners.forEach(listener =>
          listener({ allAccounts: [], caipAddress: undefined, address: undefined, isConnected: false, status })
        ),
      timedOut: startupReconnectTimedOut
    });
  });
  const [loaded] = loads;
  if (loaded === undefined) throw new Error('AppKit did not load');
  return loaded;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('keeps a stored session that connects after the bound', async () => {
  const loaded = await load('connected');
  expect(loaded.modal.subscribeAccount).toHaveBeenCalledWith(expect.any(Function), 'eip155');

  jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);

  expect(loaded.timedOut()).toBe(true);
  expect(loaded.storage.setConnectionStatus).not.toHaveBeenCalled();
  expect(loaded.storage.deleteConnectedConnectorId).not.toHaveBeenCalled();
  expect(loaded.storage.removeConnectedNamespace).not.toHaveBeenCalled();
  expect(loaded.modal.disconnect).not.toHaveBeenCalled();

  loaded.account('connected');

  expect(loaded.timedOut()).toBe(false);
  expect(loaded.storage.setConnectionStatus).not.toHaveBeenCalled();
  expect(loaded.storage.deleteConnectedConnectorId).not.toHaveBeenCalled();
  expect(loaded.storage.removeConnectedNamespace).not.toHaveBeenCalled();
  expect(loaded.modal.disconnect).not.toHaveBeenCalled();
});

it('leaves a session that AppKit restored in time', async () => {
  const loaded = await load('connected');
  loaded.account('connected');
  jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
  expect(loaded.timedOut()).toBe(false);
  expect(loaded.storage.setConnectionStatus).not.toHaveBeenCalled();
  expect(loaded.modal.disconnect).not.toHaveBeenCalled();
});

it('arms nothing on a page with no stored session', async () => {
  const loaded = await load(undefined);
  jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
  expect(loaded.timedOut()).toBe(false);
  expect(loaded.modal.disconnect).not.toHaveBeenCalled();
});
