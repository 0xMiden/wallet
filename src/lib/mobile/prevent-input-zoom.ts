/**
 * Injected into the faucet InAppBrowser (WKWebView) to stop iOS from auto-zooming
 * — and staying zoomed — when a form field with a sub-16px font gains focus (#503).
 *
 * iOS WebKit zooms the page in on focus of any input whose effective font-size is
 * below 16px, and the faucet page never zooms back out on blur, leaving it stuck.
 * Capping the viewport at `maximum-scale=1` prevents that auto-zoom entirely.
 * Unlike mobile Safari (which ignores scale limits for accessibility), an in-app
 * WKWebView honours `maximum-scale` by default (`ignoresViewportScaleLimits` is
 * false), so this is the reliable lever here.
 *
 * Accessibility note: capping `maximum-scale` at 1 disables pinch-zoom-IN for the
 * faucet WebView (WCAG 1.4.4). We deliberately do NOT add `user-scalable=no`, so
 * zoom-out is unaffected; only the sticky auto-zoom-in is suppressed. This is
 * scoped to the one faucet WebView — the wallet app itself is untouched — and is
 * the pragmatic choice over forcing `font-size:16px` on the external page's inputs
 * (which would risk reflowing the faucet's own layout).
 *
 * We rewrite only the `maximum-scale` directive and preserve everything else the
 * faucet declared (e.g. `viewport-fit=cover` for notched devices), so we don't
 * shift its layout.
 *
 * Injected via `browserPageLoaded` → `InAppBrowser.executeScript`, after the
 * faucet's own `<meta viewport>` is in place, so it overrides rather than races it.
 * NOTE: `browserPageLoaded` is the WKWebView `didFinish` (post-load), so this stops
 * the zoom for MANUAL field focus; a page that `autofocus`es a field on load could
 * still flash a zoom before this runs — fully preventing that needs a documentStart
 * user script, which the plugin only wires to `preShowScript`/`isPresentAfterPageLoad`.
 * Guarded + idempotent so repeated injections (SPA re-navigations) are no-ops.
 */
export const PREVENT_INPUT_ZOOM_SCRIPT = `
(function () {
  if (window.__preventInputZoomInjected) return;
  function enforce() {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return false;
    var meta = head.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      head.appendChild(meta);
    }
    var order = [];
    var map = {};
    (meta.getAttribute('content') || '').split(',').forEach(function (part) {
      var trimmed = part.trim();
      if (!trimmed) return;
      var eq = trimmed.indexOf('=');
      var key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
      if (!key) return;
      if (!(key in map)) order.push(key);
      map[key] = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    });
    if (!('width' in map)) { order.unshift('width'); map.width = 'device-width'; }
    if (!('initial-scale' in map)) { order.push('initial-scale'); map['initial-scale'] = '1'; }
    if (!('maximum-scale' in map)) order.push('maximum-scale');
    map['maximum-scale'] = '1';
    meta.setAttribute('content', order.map(function (k) {
      return map[k] === '' ? k : k + '=' + map[k];
    }).join(', '));
    return true;
  }
  // Latch only after a successful enforce, so an early call with no <head> yet
  // doesn't permanently suppress a later, effective injection.
  if (enforce()) window.__preventInputZoomInjected = true;
})();
`;
