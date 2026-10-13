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

const mockApplyOverride = jest.fn<Promise<void>, [{ networkName: MIDEN_NETWORK_NAME }]>();
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  buildDefaultOverrideFor: (networkName: MIDEN_NETWORK_NAME) => ({ networkName }),
  applyEndpointOverride: (override: { networkName: MIDEN_NETWORK_NAME }) => mockApplyOverride(override)
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
    expect(mockApplyOverride).toHaveBeenCalledWith({ networkName: MIDEN_NETWORK_NAME.MAINNET });
    expect(steps).toEqual(['wipe', 'network', 'reload']);
  });

  it('does not change networks when the wipe fails', async () => {
    mockIsExtension.value = true;
    resetStorageDestructive.mockRejectedValueOnce(new Error('Wipe failed'));
    await resetWalletAndReload(onWipeError, MIDEN_NETWORK_NAME.MAINNET);
    expect(mockApplyOverride).not.toHaveBeenCalled();
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
