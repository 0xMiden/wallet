import type { EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { ResetAndReloadError, resetWalletAndReload } from './reset-and-reload';

const mockIsExtension = { value: false };
jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension.value
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
  const onWipeError = jest.fn<Promise<void>, [unknown]>(async () => {});

  beforeEach(() => {
    mockIsExtension.value = false;
    runtimeReload.mockReset();
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
    expect(onWipeError).not.toHaveBeenCalled();
  });

  it('sets mainnet after the wipe and before reload', async () => {
    mockIsExtension.value = true;
    const steps: string[] = [];
    resetStorageDestructive.mockImplementationOnce(async () => {
      steps.push('wipe');
    });
    mockApplyOverride.mockImplementationOnce(async () => {
      steps.push('network');
    });
    runtimeReload.mockImplementationOnce(() => {
      steps.push('reload');
    });
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET);
    expect(steps).toEqual(['wipe', 'network', 'reload']);
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

  it('carries an accepted access code past the wipe, after the network choice and before reload', async () => {
    mockIsExtension.value = true;
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
    runtimeReload.mockImplementationOnce(() => {
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

  it('finishes the switch when the code cannot be carried: the code step asks for it again', async () => {
    mockIsExtension.value = true;
    mockCarryCode.mockRejectedValueOnce(new Error('storage full'));
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET, '8gKIgL0O6HcU');
    expect(onWipeError).not.toHaveBeenCalled();
    expect(mockApplyOverride).toHaveBeenCalledTimes(1);
    expect(runtimeReload).toHaveBeenCalledTimes(1);
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
