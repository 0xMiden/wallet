import { getEffectiveFaucetUrl } from 'lib/miden-chain/effective-endpoints';

/**
 * The faucet site pads its body by `env(safe-area-inset-top)` so its content clears the status bar
 * when it fills the screen. In the wallet it opens in the dApp browser under the wallet's own header,
 * but iOS still reports the phone's ~62pt top inset to the page, so the form started a status bar's
 * height below the header. This builds the script that drops that padding. It is injected on iOS only,
 * for a session whose origin `urlChangeEvent` has confirmed as the faucet's. The WebView may still be
 * showing another document when the script lands, so it returns unless the document it runs in has
 * `faucetOrigin` as its own origin. It is idempotent, since several events (page loaded, origin
 * confirmed) may inject it.
 */
export function faucetNoTopInsetScript(faucetOrigin: string): string {
  return `
(function () {
  if (location.origin !== ${JSON.stringify(faucetOrigin)}) return;
  if (document.getElementById('miden-faucet-no-top-inset')) return;
  var style = document.createElement('style');
  style.id = 'miden-faucet-no-top-inset';
  style.textContent = 'body { padding-top: 0 !important; }';
  (document.head || document.documentElement).appendChild(style);
})();
`;
}

/** Whether `origin` is the active network's faucet, the one page the script above is for. */
export function isFaucetOrigin(origin: string): boolean {
  const faucetUrl = getEffectiveFaucetUrl();
  if (!faucetUrl) return false;
  try {
    return new URL(faucetUrl).origin === origin;
  } catch {
    return false;
  }
}
