import { registerPlugin } from '@capacitor/core';

import type { PaymentWalletId, WalletPaymentLink } from 'lib/one-click/payment-links';
import { isMobile } from 'lib/platform';

interface WalletPaymentsPlugin {
  available(): Promise<{ wallets: PaymentWalletId[] }>;
  open(options: { wallet: PaymentWalletId; url: string; deadline: number }): Promise<{ opened: boolean }>;
}

const WalletPayments = registerPlugin<WalletPaymentsPlugin>('WalletPayments');

/** Check the fixed wallet list. This does not open an app or a download page. */
export async function availablePaymentWallets(): Promise<PaymentWalletId[]> {
  if (!isMobile()) return [];
  const result = await WalletPayments.available();
  return result.wallets;
}

export async function openWalletPayment(link: WalletPaymentLink, deadline: number): Promise<boolean> {
  if (!isMobile() || !Number.isFinite(deadline) || Date.now() >= deadline) return false;
  const result = await WalletPayments.open({ ...link, deadline });
  return result.opened;
}
