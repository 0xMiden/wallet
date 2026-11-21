import { isMobile } from 'lib/platform';

import { availablePaymentWallets, openWalletPayment } from './wallet-payments';

const mockAvailable = jest.fn();
const mockOpen = jest.fn();
jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    available: () => mockAvailable(),
    open: (options: { wallet: string; url: string; deadline: number }) => mockOpen(options)
  })
}));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));

beforeEach(() => {
  jest.mocked(isMobile).mockReturnValue(true);
  mockAvailable.mockResolvedValue({ wallets: ['trust'] });
  mockOpen.mockResolvedValue({ opened: true });
});
afterEach(() => jest.clearAllMocks());

it('reads the native installed-wallet list', async () => {
  await expect(availablePaymentWallets()).resolves.toEqual(['trust']);
});

it('passes the wallet, URL and deadline to the native opener', async () => {
  const deadline = Date.now() + 60_000;
  await expect(openWalletPayment({ wallet: 'trust', url: 'trust://send?asset=c0' }, deadline)).resolves.toBe(true);
  expect(mockOpen).toHaveBeenCalledWith({ wallet: 'trust', url: 'trust://send?asset=c0', deadline });
});

it('does not call native APIs on desktop or extension', async () => {
  jest.mocked(isMobile).mockReturnValue(false);
  await expect(availablePaymentWallets()).resolves.toEqual([]);
  await expect(openWalletPayment({ wallet: 'trust', url: 'trust://send' }, Date.now() + 60_000)).resolves.toBe(false);
  expect(mockAvailable).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('refuses expired or invalid deadlines', async deadline => {
  await expect(openWalletPayment({ wallet: 'trust', url: 'trust://send' }, deadline)).resolves.toBe(false);
  expect(mockOpen).not.toHaveBeenCalled();
});
