import type { PaymentWalletId } from 'lib/one-click/payment-links';

import metamaskIcon from '../../assets/wallets/metamask.svg?url';
import phantomIcon from '../../assets/wallets/phantom.svg?url';
import rainbowIcon from '../../assets/wallets/rainbow.svg?url';
import trustIcon from '../../assets/wallets/trust.svg?url';

/**
 * The name key and the icon of each payment wallet. It is the same table as the one in
 * `screens/near-intents-flow/DepositWalletGrid.tsx`; that screen can import this one.
 */
export const PAYMENT_WALLET_DISPLAY: Record<PaymentWalletId, { label: string; image: string }> = {
  trust: { label: 'paymentWalletTrust', image: trustIcon },
  metamask: { label: 'paymentWalletMetamask', image: metamaskIcon },
  rainbow: { label: 'paymentWalletRainbow', image: rainbowIcon },
  phantom: { label: 'paymentWalletPhantom', image: phantomIcon }
};
