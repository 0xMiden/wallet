import { act, renderHook } from '@testing-library/react';

import { completeWalletPrompt, faucet, WalletPromptStatus, WalletPromptType } from 'lib/wallet-prompts';

import {
  _resetWalletFundingForTest,
  closeWalletFunding,
  getWalletFundingState,
  openWalletFunding,
  retryWalletFunding,
  startWalletFunding,
  useWalletFunding
} from './wallet-funding';

jest.mock('lib/wallet-prompts', () => {
  const actual = jest.requireActual('lib/wallet-prompts');
  return {
    ...actual,
    completeWalletPrompt: jest.fn(),
    faucet: jest.fn()
  };
});

const completeWalletPromptMock = jest.mocked(completeWalletPrompt);
const faucetMock = jest.mocked(faucet);

describe('wallet funding lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetWalletFundingForTest();
    faucetMock.mockResolvedValue(undefined);
    completeWalletPromptMock.mockResolvedValue({
      version: 1,
      prompts: { [WalletPromptType.Faucet]: WalletPromptStatus.Completed },
      pendingNotesDismissedIds: []
    });
  });

  it('opens idle and starts the faucet only when the drawer mounts', async () => {
    openWalletFunding('account-a');

    expect(getWalletFundingState()).toEqual({
      open: true,
      status: 'idle',
      address: 'account-a',
      error: null
    });
    expect(faucetMock).not.toHaveBeenCalled();

    await startWalletFunding();

    expect(faucetMock).toHaveBeenCalledWith('account-a');
    expect(completeWalletPromptMock).toHaveBeenCalledWith(WalletPromptType.Faucet);
    expect(getWalletFundingState().status).toBe('success');
  });

  it('continues after the drawer and its subscriber unmount while sharing one request', async () => {
    let resolveFaucet = () => {};
    faucetMock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveFaucet = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useWalletFunding());

    act(() => openWalletFunding('account-a'));
    let firstRequest: Promise<void> = Promise.resolve();
    act(() => {
      firstRequest = startWalletFunding();
    });
    const remountedRequest = startWalletFunding();
    expect(result.current.status).toBe('loading');
    expect(faucetMock).toHaveBeenCalledTimes(1);
    expect(remountedRequest).toBe(firstRequest);

    act(() => closeWalletFunding());
    expect(result.current.open).toBe(false);
    act(() => openWalletFunding('account-b'));
    expect(result.current).toEqual({
      open: true,
      status: 'loading',
      address: 'account-a',
      error: null
    });
    expect(retryWalletFunding()).toBe(firstRequest);
    act(() => closeWalletFunding());
    unmount();

    resolveFaucet();
    await firstRequest;

    expect(getWalletFundingState()).toEqual({
      open: false,
      status: 'success',
      address: 'account-a',
      error: null
    });
  });

  it('shows the faucet error and retries without losing the address', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    faucetMock.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce(undefined);
    openWalletFunding('account-a');

    await startWalletFunding();

    expect(getWalletFundingState()).toEqual({
      open: true,
      status: 'failure',
      address: 'account-a',
      error: 'rate limited'
    });

    await retryWalletFunding();

    expect(faucetMock).toHaveBeenCalledTimes(2);
    expect(getWalletFundingState().status).toBe('success');
    errorSpy.mockRestore();
  });

  it('stringifies non-Error failures', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    faucetMock.mockRejectedValue('offline');
    openWalletFunding('account-a');

    await startWalletFunding();

    expect(getWalletFundingState().error).toBe('offline');
    errorSpy.mockRestore();
  });

  it('keeps API success when prompt completion persistence fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    completeWalletPromptMock.mockRejectedValue(new Error('storage full'));
    openWalletFunding('account-a');

    await startWalletFunding();

    expect(getWalletFundingState().status).toBe('success');
    expect(warnSpy).toHaveBeenCalledWith('[wallet-funding] failed to complete faucet prompt:', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('no-ops start and retry without an address', async () => {
    await startWalletFunding();
    await retryWalletFunding();

    expect(faucetMock).not.toHaveBeenCalled();
  });
});
