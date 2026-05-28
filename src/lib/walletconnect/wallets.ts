/**
 * Popular EVM wallets that handle `wc:` URIs via universal/deep links.
 *
 * On iOS/Android we surface these as "Open in X" buttons. The native URL
 * scheme is checked first (`{scheme}://wc?uri=...`); if the user doesn't
 * have the app installed iOS will fail silently — we fall back to the
 * https universal link so the App Store opens instead.
 */

export type WcWallet = {
  id: string;
  name: string;
  nativeScheme: string;
  universalLink: string;
};

export const POPULAR_WALLETS: WcWallet[] = [
  {
    id: 'metamask',
    name: 'MetaMask',
    nativeScheme: 'metamask://',
    universalLink: 'https://metamask.app.link/'
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    nativeScheme: 'rainbow://',
    universalLink: 'https://rnbwapp.com/'
  },
  {
    id: 'trust',
    name: 'Trust Wallet',
    nativeScheme: 'trust://',
    universalLink: 'https://link.trustwallet.com/'
  },
  {
    id: 'zerion',
    name: 'Zerion',
    nativeScheme: 'zerion://',
    universalLink: 'https://wallet.zerion.io/'
  }
];

function withWc(base: string, wcUri: string): string {
  const encoded = encodeURIComponent(wcUri);
  return base.endsWith('/') ? `${base}wc?uri=${encoded}` : `${base}/wc?uri=${encoded}`;
}

export function buildNativeLink(wallet: WcWallet, wcUri: string): string {
  return withWc(wallet.nativeScheme, wcUri);
}

export function buildUniversalLink(wallet: WcWallet, wcUri: string): string {
  return withWc(wallet.universalLink, wcUri);
}
