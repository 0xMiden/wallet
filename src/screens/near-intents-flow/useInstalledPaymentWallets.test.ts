import { act, renderHook, waitFor } from '@testing-library/react';

import { availablePaymentWallets } from 'lib/mobile/wallet-payments';
import type { WalletPaymentLink } from 'lib/one-click/payment-links';
import { isMobile } from 'lib/platform';

import { installedPaymentLinks, useInstalledPaymentWallets } from './useInstalledPaymentWallets';

jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/mobile/wallet-payments', () => ({ availablePaymentWallets: jest.fn() }));
const mockRemove = jest.fn();
let mockResume: (isActive: boolean) => void = () => {};
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn((_event: string, listener: (state: { isActive: boolean }) => void) => {
      mockResume = isActive => listener({ isActive });
      return Promise.resolve({ remove: mockRemove });
    })
  }
}));

const link = (wallet: WalletPaymentLink['wallet']): WalletPaymentLink => ({ wallet, url: `${wallet}://pay` });

beforeEach(() => {
  jest.mocked(isMobile).mockReturnValue(true);
  jest.mocked(availablePaymentWallets).mockResolvedValue(['trust', 'metamask']);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('useInstalledPaymentWallets', () => {
  it('reads the installed wallets, again when the app comes back, and stops on unmount', async () => {
    const { result, unmount } = renderHook(() => useInstalledPaymentWallets());
    await waitFor(() => expect(result.current).toEqual(['trust', 'metamask']));

    jest.mocked(availablePaymentWallets).mockResolvedValue(['rainbow']);
    await act(async () => {
      mockResume(false);
    });
    expect(availablePaymentWallets).toHaveBeenCalledTimes(1);
    await act(async () => {
      mockResume(true);
    });
    await waitFor(() => expect(result.current).toEqual(['rainbow']));

    unmount();
    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
  });

  it('keeps no wallet when the read fails', async () => {
    jest.mocked(availablePaymentWallets).mockRejectedValue(new Error('no plugin'));
    const { result } = renderHook(() => useInstalledPaymentWallets());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });

  it('reads nothing off mobile', () => {
    jest.mocked(isMobile).mockReturnValue(false);
    const { result } = renderHook(() => useInstalledPaymentWallets());
    expect(result.current).toEqual([]);
    expect(availablePaymentWallets).not.toHaveBeenCalled();
  });
});

describe('installedPaymentLinks', () => {
  it('keeps the installed wallets and leaves out Phantom when Trust Wallet is installed', () => {
    const links = [link('trust'), link('metamask'), link('phantom'), link('rainbow')];
    expect(installedPaymentLinks(links, ['trust', 'phantom', 'metamask']).map(entry => entry.wallet)).toEqual([
      'trust',
      'metamask'
    ]);
    expect(installedPaymentLinks(links, ['phantom']).map(entry => entry.wallet)).toEqual(['phantom']);
  });
});
