import { isMobile } from 'lib/platform';

import { getDepositToken, type DepositTokenId } from './tokens';

/** The deposit address only watches Sepolia; every payment link pins it. */
export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * EIP-681 payment-request URI asking an external EVM wallet to fund the
 * deposit address. Native ETH rides `?value=`; ERC-20 uses the `/transfer`
 * function form with the token contract as the target. Amount is in base
 * units. Scannable by MetaMask mobile, Trust, Rainbow, Coinbase Wallet, etc.
 */
export function buildDepositPaymentUri(token: DepositTokenId, depositAddress: string, amount: bigint): string {
  const config = getDepositToken(token);
  if (config.address) {
    return `ethereum:${config.address}@${SEPOLIA_CHAIN_ID}/transfer?address=${depositAddress}&uint256=${amount.toString()}`;
  }
  return `ethereum:${depositAddress}@${SEPOLIA_CHAIN_ID}?value=${amount.toString()}`;
}

/**
 * EXPERIMENT: hand the `ethereum:` URI straight to the platform and see what
 * claims it. On mobile the Capacitor WebView forwards non-http(s) navigations
 * to the OS (installed wallet or silent no-op); elsewhere the browser decides.
 * If this proves unreliable we switch to per-wallet universal links
 * (link.metamask.io etc.) behind installed-wallet detection.
 */
export function openPaymentDeeplink(uri: string): void {
  if (isMobile()) {
    window.location.href = uri;
    return;
  }
  window.open(uri, '_blank');
}
