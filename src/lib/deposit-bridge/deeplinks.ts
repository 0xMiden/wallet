import { isMobile } from 'lib/platform';

import { getDepositToken, type DepositTokenId } from './tokens';

/** The deposit address only watches Sepolia; every payment link pins it. */
export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * EIP-681 payment-request suffix (everything after the `ethereum:` scheme):
 * native ETH rides `?value=`; ERC-20 uses the `/transfer` function form with
 * the token contract as the target. Amount is in base units. The same suffix
 * feeds both the bare `ethereum:` URI and wallet universal links.
 */
function paymentRequestSuffix(token: DepositTokenId, depositAddress: string, amount: bigint): string {
  const config = getDepositToken(token);
  if (config.address) {
    return `${config.address}@${SEPOLIA_CHAIN_ID}/transfer?address=${depositAddress}&uint256=${amount.toString()}`;
  }
  return `${depositAddress}@${SEPOLIA_CHAIN_ID}?value=${amount.toString()}`;
}

/**
 * EIP-681 payment-request URI asking an external EVM wallet to fund the
 * deposit address. Scannable by MetaMask mobile, Trust, Rainbow, Coinbase
 * Wallet, etc.; as a tapped link the OS hands it to whichever installed
 * wallet last claimed the `ethereum:` scheme (no chooser on iOS).
 */
export function buildDepositPaymentUri(token: DepositTokenId, depositAddress: string, amount: bigint): string {
  return `ethereum:${paymentRequestSuffix(token, depositAddress, amount)}`;
}

/** Wallets the deposit sheet can hand the payment request to by name. */
export type DepositWalletId = 'metamask' | 'default';

export interface DepositWalletOption {
  id: DepositWalletId;
  /** Brand name rendered verbatim; empty = use the translated fallback label. */
  name: string;
  /** i18n key of the row subtitle. */
  descriptionKey: string;
  buildUri: (token: DepositTokenId, depositAddress: string, amount: bigint) => string;
}

/**
 * Per-wallet launch targets. A bare `ethereum:` URI cannot target a specific
 * app — the OS hands it to whichever installed wallet last claimed the scheme
 * — so naming a wallet here requires that wallet's own HTTPS universal link.
 * MetaMask gets its documented one (guaranteed routing + App Store fallback;
 * its raw-scheme parser is stricter and rejects some valid EIP-681 URIs).
 * "Default" is the honest label for the bare scheme. Trust is deliberately
 * absent — no usable Sepolia support; add wallets here as their send-prefill
 * universal links are verified.
 */
export const DEPOSIT_WALLETS: readonly DepositWalletOption[] = [
  {
    id: 'metamask',
    name: 'MetaMask',
    descriptionKey: 'depositWalletUniversalLink',
    buildUri: (token, depositAddress, amount) =>
      `https://link.metamask.io/send/${paymentRequestSuffix(token, depositAddress, amount)}`
  },
  {
    id: 'default',
    name: '',
    descriptionKey: 'depositWalletEthereumScheme',
    buildUri: buildDepositPaymentUri
  }
];

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
