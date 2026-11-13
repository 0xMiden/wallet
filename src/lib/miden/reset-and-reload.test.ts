import type { EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import type { ExtensionResetOptions } from 'lib/miden/platform-reset';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { ResetAndReloadError, resetWalletAndReload } from './reset-and-reload';

const mockIsExtension = { value: false };
// False on an extension page an extension reload or update orphaned.
const mockHasExtensionRuntime = { value: true };
const mockReloadInPlace = jest.fn();
jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension.value,
  hasExtensionRuntime: () => mockIsExtension.value && mockHasExtensionRuntime.value,
  reloadInPlace: () => mockReloadInPlace()
}));

// `browser.runtime.reload` is spy-able; `window.location.reload` is a non-configurable jsdom getter
// (CLAUDE.md), so the non-extension path is checked by a clean completion that never took the extension branch.
const runtimeReload = jest.fn();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: { runtime: { reload: () => runtimeReload() } }
}));

const resetStorageDestructive = jest.fn<Promise<void>, []>();
jest.mock('lib/miden/reset', () => ({
  resetStorageDestructive: () => resetStorageDestructive()
}));
const mockRequestReset = jest.fn(async (_options: ExtensionResetOptions) => resetStorageDestructive());
jest.mock('lib/miden/platform-reset', () => ({
  requestExtensionReset: (options: ExtensionResetOptions) => mockRequestReset(options)
}));

const mockApplyOverride = jest.fn<Promise<void>, [EndpointOverride]>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  applyEndpointOverride: (override: EndpointOverride) => mockApplyOverride(override)
}));

const mockCarryCode = jest.fn<Promise<void>, [string]>();
jest.mock('lib/carried-mainnet-code', () => ({
  carryMainnetAccessCode: (code: string) => mockCarryCode(code)
}));

describe('resetWalletAndReload', () => {
  it('binds the endpoint switch and accepted code inside the worker reset request', async () => {
    mockIsExtension.value = true;
    mockRequestReset.mockClear();
    await resetWalletAndReload(async () => undefined, MIDEN_NETWORK_NAME.MAINNET, 'fixture code');
    expect(mockRequestReset).toHaveBeenCalledWith({ keepEndpointOverride: true,
      targetNetwork: MIDEN_NETWORK_NAME.MAINNET, accessCode: 'fixture code' });
  });
  const onWipeError = jest.fn<Promise<void>, [unknown]>(async () => {});

  beforeEach(() => {
    mockIsExtension.value = false;
    mockHasExtensionRuntime.value = true;
    runtimeReload.mockReset();
    mockReloadInPlace.mockReset();
    resetStorageDestructive.mockReset();
    resetStorageDestructive.mockResolvedValue(undefined);
    onWipeError.mockClear();
    mockApplyOverride.mockReset().mockResolvedValue(undefined);
    mockCarryCode.mockReset().mockResolvedValue(undefined);
  });

  it('wipes with the endpoint override kept, then reloads in place off the extension', async () => {
    await expect(resetWalletAndReload(onWipeError)).resolves.toBeUndefined();

    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockReloadInPlace).toHaveBeenCalledTimes(1);
    expect(onWipeError).not.toHaveBeenCalled();
  });

  it('reloads in place on an extension page that has lost its runtime, which cannot reload the extension', async () => {
    mockIsExtension.value = true;
    mockHasExtensionRuntime.value = false;
    resetStorageDestructive.mockImplementationOnce(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    await expect(resetWalletAndReload(onWipeError)).resolves.toBeUndefined();

    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(runtimeReload).not.toHaveBeenCalled();
    expect(mockReloadInPlace).toHaveBeenCalledTimes(1);
  });

  it('sets mainnet locally after the native wipe and before reload', async () => {
    mockIsExtension.value = false;
    const steps: string[] = [];
    resetStorageDestructive.mockImplementationOnce(async () => {
      steps.push('wipe');
    });
    mockApplyOverride.mockImplementationOnce(async () => {
      steps.push('network');
    });
    mockReloadInPlace.mockImplementationOnce(() => {
      steps.push('reload');
    });
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET);
    expect(steps).toEqual(['wipe', 'network', 'reload']);
    expect(runtimeReload).not.toHaveBeenCalled();
    // The network choice alone: the build's current mainnet endpoints, never a copy pinned now.
    expect(mockApplyOverride).toHaveBeenCalledWith({
      rpcUrl: '',
      proverUrl: '',
      noteTransportUrl: '',
      faucetUrl: '',
      faucetApiUrl: '',
      explorerUrl: '',
      guardianUrl: '',
      allowNoGuardian: false,
      networkName: MIDEN_NETWORK_NAME.MAINNET,
      presetName: MIDEN_NETWORK_NAME.MAINNET
    });
  });

  it('does not change networks when the wipe fails', async () => {
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('Wipe failed'));
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET);
    expect(mockApplyOverride).not.toHaveBeenCalled();
  });

  it('carries an accepted code locally after the native wipe and network choice', async () => {
    mockIsExtension.value = false;
    const steps: string[] = [];
    resetStorageDestructive.mockImplementationOnce(async () => {
      steps.push('wipe');
    });
    mockApplyOverride.mockImplementationOnce(async () => {
      steps.push('network');
    });
    mockCarryCode.mockImplementationOnce(async () => {
      steps.push('code');
    });
    mockReloadInPlace.mockImplementationOnce(() => {
      steps.push('reload');
    });
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET, '8gKIgL0O6HcU');
    expect(steps).toEqual(['wipe', 'network', 'code', 'reload']);
    expect(mockCarryCode).toHaveBeenCalledWith('8gKIgL0O6HcU');
  });

  it('carries no code when the wipe fails', async () => {
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('Wipe failed'));
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET, '8gKIgL0O6HcU');
    expect(mockCarryCode).not.toHaveBeenCalled();
  });

  it('finishes the native switch when the code cannot be carried', async () => {
    mockIsExtension.value = false;
    mockCarryCode.mockRejectedValueOnce(new Error('storage full'));
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET, '8gKIgL0O6HcU');
    expect(onWipeError).not.toHaveBeenCalled();
    expect(mockApplyOverride).toHaveBeenCalledTimes(1);
    expect(mockReloadInPlace).toHaveBeenCalledTimes(1);
  });

  it('reloads the extension once, through the polyfill', async () => {
    mockIsExtension.value = true;

    await resetWalletAndReload(onWipeError);

    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('reloads the extension from pagehide when the page closes during the wipe, and not again', async () => {
    mockIsExtension.value = true;
    resetStorageDestructive.mockImplementationOnce(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    await resetWalletAndReload(onWipeError);

    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected wipe and still reloads', async () => {
    mockIsExtension.value = true;
    const failure = new Error('wipe');
    resetStorageDestructive.mockRejectedValueOnce(failure);

    await resetWalletAndReload(onWipeError);

    expect(onWipeError).toHaveBeenCalledWith(failure);
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('reports a reload that cannot start', async () => {
    mockIsExtension.value = true;
    runtimeReload.mockImplementationOnce(() => {
      throw new Error('no reload');
    });

    await expect(resetWalletAndReload(onWipeError)).rejects.toMatchObject<Partial<ResetAndReloadError>>({
      step: 'reload'
    });
    expect(resetStorageDestructive).toHaveBeenCalledTimes(1);
  });
});
