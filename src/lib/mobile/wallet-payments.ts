import { registerPlugin } from '@capacitor/core';

import type { PaymentWalletId, WalletPaymentLink } from 'lib/one-click/payment-links';
import { isMobile } from 'lib/platform';

interface WalletPaymentsPlugin {
  available(): Promise<{ wallets: PaymentWalletId[] }>;
  open(options: { wallet: PaymentWalletId; url: string; deadline: number }): Promise<{ opened: boolean }>;
}

const WalletPayments = registerPlugin<WalletPaymentsPlugin>('WalletPayments');

/**
 * The time that the native opener gets to open a link when the caller has no deadline of its own (an address with no
 * expiry). The native side refuses a link after its deadline.
 */
export const WALLET_OPEN_WINDOW_MS = 60_000;

/** Check the fixed wallet list. This does not open an app or a download page. */
export async function availablePaymentWallets(): Promise<PaymentWalletId[]> {
  if (!isMobile()) return [];
  const result = await WalletPayments.available();
  return result.wallets;
}

/**
 * Opens a payment link in its wallet app, on mobile only. `deadline` (Unix milliseconds) is the time after which the
 * link must not open: a deadline that is not finite or has passed opens nothing. Without `deadline` (an address with no
 * expiry), the link can open during `WALLET_OPEN_WINDOW_MS` from now.
 */
export async function openWalletPayment(link: WalletPaymentLink, deadline?: number): Promise<boolean> {
  if (!isMobile()) return false;
  const until = deadline === undefined ? Date.now() + WALLET_OPEN_WINDOW_MS : deadline;
  if (!Number.isFinite(until) || Date.now() >= until) return false;
  const result = await WalletPayments.open({ ...link, deadline: until });
  return result.opened;
}
