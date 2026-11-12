import React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { IOneClickTrackingData } from 'lib/miden/db/types';
import { availablePaymentWallets, openWalletPayment } from 'lib/mobile/wallet-payments';
import { PAYMENT_NOW, paymentTracking } from 'lib/one-click/testing/payment-tracking';
import { isMobile } from 'lib/platform';

import { DepositWalletGrid } from './DepositWalletGrid';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/wallet-payments', () => ({
  availablePaymentWallets: jest.fn(),
  openWalletPayment: jest.fn()
}));
const mockRemove = jest.fn();
let mockResume: () => void;
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn((_event: string, listener: (state: { isActive: boolean }) => void) => {
      mockResume = () => listener({ isActive: true });
      return Promise.resolve({ remove: mockRemove });
    })
  }
}));

function tracking(): IOneClickTrackingData {
  const row = paymentTracking();
  row.originAsset = { ...row.originAsset, contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
  return row;
}

function solanaTracking(): IOneClickTrackingData {
  return paymentTracking({
    originAsset: { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
    depositAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  });
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(PAYMENT_NOW);
  jest.mocked(isMobile).mockReturnValue(true);
  jest.mocked(availablePaymentWallets).mockResolvedValue(['trust', 'metamask', 'rainbow', 'phantom']);
  jest.mocked(openWalletPayment).mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('shows installed compatible wallets with icons and excludes Phantom on EVM', async () => {
  render(<DepositWalletGrid tracking={tracking()} />);
  expect(await screen.findByTestId('deposit-pay-trust')).toBeInTheDocument();
  expect(screen.getByTestId('deposit-pay-metamask')).toBeInTheDocument();
  expect(screen.getByTestId('deposit-pay-rainbow')).toBeInTheDocument();
  expect(screen.queryByTestId('deposit-pay-phantom')).not.toBeInTheDocument();
  expect(screen.getByTestId('deposit-pay-trust').querySelector('img')).toHaveAttribute('src');
  fireEvent.click(screen.getByTestId('deposit-pay-metamask'));
  await waitFor(() =>
    expect(openWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: 'metamask', url: expect.stringContaining('uint256=46000000') }),
      Date.parse('2026-11-10T14:32:00Z')
    )
  );
});

it('hides Phantom for Solana when Trust Wallet is installed', async () => {
  render(<DepositWalletGrid tracking={solanaTracking()} />);
  expect(await screen.findByTestId('deposit-pay-trust')).toBeInTheDocument();
  expect(screen.queryByTestId('deposit-pay-phantom')).not.toBeInTheDocument();
});

it('keeps Phantom available for Solana when Trust Wallet is not installed', async () => {
  jest.mocked(availablePaymentWallets).mockResolvedValue(['phantom']);
  render(<DepositWalletGrid tracking={solanaTracking()} />);
  fireEvent.click(await screen.findByTestId('deposit-pay-phantom'));
  await waitFor(() =>
    expect(openWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: 'phantom', url: expect.stringContaining('solana:') }),
      Date.parse('2026-11-10T14:32:00Z')
    )
  );
  expect(screen.queryByTestId('deposit-pay-trust')).not.toBeInTheDocument();
});

it('hides Phantom when Trust Wallet is detected after returning to the app', async () => {
  jest.mocked(availablePaymentWallets).mockResolvedValue(['phantom']);
  render(<DepositWalletGrid tracking={solanaTracking()} />);
  await screen.findByTestId('deposit-pay-phantom');
  jest.mocked(availablePaymentWallets).mockResolvedValue(['trust', 'phantom']);
  await act(async () => mockResume());
  expect(screen.getByTestId('deposit-pay-trust')).toBeInTheDocument();
  expect(screen.queryByTestId('deposit-pay-phantom')).not.toBeInTheDocument();
});

it('hides the section on non-mobile surfaces and when no compatible app is installed', async () => {
  jest.mocked(isMobile).mockReturnValue(false);
  const view = render(<DepositWalletGrid tracking={tracking()} />);
  expect(screen.queryByTestId('deposit-wallet-grid')).not.toBeInTheDocument();
  expect(availablePaymentWallets).not.toHaveBeenCalled();
  view.unmount();
  jest.mocked(isMobile).mockReturnValue(true);
  jest.mocked(availablePaymentWallets).mockResolvedValue(['phantom']);
  render(<DepositWalletGrid tracking={tracking()} />);
  await waitFor(() => expect(availablePaymentWallets).toHaveBeenCalled());
  expect(screen.queryByTestId('deposit-wallet-grid')).not.toBeInTheDocument();
});

it('checks installed apps again when the app resumes', async () => {
  const view = render(<DepositWalletGrid tracking={tracking()} />);
  await screen.findByTestId('deposit-pay-trust');
  jest.mocked(availablePaymentWallets).mockResolvedValue(['metamask']);
  await act(async () => mockResume());
  expect(screen.queryByTestId('deposit-pay-trust')).not.toBeInTheDocument();
  view.unmount();
  await waitFor(() => expect(mockRemove).toHaveBeenCalled());
});

it('shows a copy fallback message when opening fails', async () => {
  jest.mocked(openWalletPayment).mockRejectedValue(new Error('unavailable'));
  render(<DepositWalletGrid tracking={tracking()} />);
  fireEvent.click(await screen.findByTestId('deposit-pay-trust'));
  expect(await screen.findByTestId('deposit-wallet-open-failed')).toHaveTextContent('depositWalletOpenFailed');
});

it('does not open a link if the quote expires between render and tap', async () => {
  render(<DepositWalletGrid tracking={tracking()} />);
  const button = await screen.findByTestId('deposit-pay-trust');
  jest.mocked(Date.now).mockReturnValue(PAYMENT_NOW + 10 * 60_000);
  fireEvent.click(button);
  expect(openWalletPayment).not.toHaveBeenCalled();
});

it('hides payment actions when processing starts', async () => {
  const row = tracking();
  const view = render(<DepositWalletGrid tracking={row} />);
  await screen.findByTestId('deposit-pay-trust');
  view.rerender(<DepositWalletGrid tracking={{ ...row, phase: 'processing' }} />);
  expect(screen.queryByTestId('deposit-wallet-grid')).not.toBeInTheDocument();
});
