import { createIntercomClient } from 'lib/intercom/client';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { WalletMessageType } from 'lib/shared/types';

import { installBackupSignalHandler, signalGuardianStateAdopted, signalTransactionCompleted } from './adopt-signal';
import { isWalletApiEnabled } from './api-client';

const mockRequest = jest.fn();

jest.mock('./api-client', () => ({ isWalletApiEnabled: jest.fn() }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => ({ request: mockRequest, subscribe: jest.fn() }))
}));

function snapshot(status: BridgeConfigSnapshot['status']): BridgeConfigSnapshot {
  return { network: 'testnet', status, config: null, derived: null, lastFetch: null };
}

/** Let the lazy forwarder load and send. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  installBackupSignalHandler(null);
  mockRequest.mockReset().mockResolvedValue({ type: WalletMessageType.BackupRefreshResponse, outcome: 'unchanged' });
  jest.mocked(isWalletApiEnabled).mockReset().mockReturnValue(true);
  jest.mocked(getBridgeConfigSnapshot).mockReset().mockReturnValue(snapshot('ready'));
});

afterEach(() => jest.restoreAllMocks());

describe('backup signals', () => {
  it('call the installed handler directly with the reason, and forward nothing', async () => {
    const handler = jest.fn();
    installBackupSignalHandler(handler);
    signalGuardianStateAdopted();
    signalTransactionCompleted();
    await settle();
    expect(handler.mock.calls).toEqual([['guardian-adopt'], ['transaction-completed']]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('forward a BackupRefreshRequest to the backend in a realm with no handler', async () => {
    signalGuardianStateAdopted();
    signalTransactionCompleted();
    await settle();
    expect(mockRequest.mock.calls).toEqual([
      [{ type: WalletMessageType.BackupRefreshRequest, reason: 'guardian-adopt' }],
      [{ type: WalletMessageType.BackupRefreshRequest, reason: 'transaction-completed' }]
    ]);
    // One intercom client serves every forward.
    signalGuardianStateAdopted();
    await settle();
    expect(jest.mocked(createIntercomClient)).toHaveBeenCalledTimes(1);
  });

  it('drop the signal only when the bridge config settled with no base URL', async () => {
    const handler = jest.fn();
    installBackupSignalHandler(handler);
    jest.mocked(isWalletApiEnabled).mockReturnValue(false);
    signalGuardianStateAdopted();
    expect(handler).not.toHaveBeenCalled();

    installBackupSignalHandler(null);
    signalTransactionCompleted();
    await settle();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('keep the signal while the bridge config still loads, so the backend makes the real check', async () => {
    jest.mocked(isWalletApiEnabled).mockReturnValue(false);
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot('loading'));
    const handler = jest.fn();
    installBackupSignalHandler(handler);
    signalGuardianStateAdopted();
    expect(handler).toHaveBeenCalledWith('guardian-adopt');

    installBackupSignalHandler(null);
    signalTransactionCompleted();
    await settle();
    expect(mockRequest).toHaveBeenCalledWith({
      type: WalletMessageType.BackupRefreshRequest,
      reason: 'transaction-completed'
    });
  });

  it('never throw: a handler error and a failed forward are logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installBackupSignalHandler(() => {
      throw new Error('handler failed');
    });
    expect(() => signalGuardianStateAdopted()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[backup] the Guardian adoption signal failed', expect.any(Error));

    installBackupSignalHandler(null);
    mockRequest.mockRejectedValueOnce(new Error('no backend'));
    expect(() => signalTransactionCompleted()).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledWith(
      '[backup] the transaction completion signal was not delivered',
      expect.any(Error)
    );
  });

  it('never throw when the bridge config check throws', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(isWalletApiEnabled).mockImplementation(() => {
      throw new Error('no snapshot');
    });
    expect(() => signalTransactionCompleted()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
