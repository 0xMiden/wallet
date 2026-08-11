import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';

/** Toolbar colors for `@miden/dapp-browser` InAppBrowser overlays (#503). */
export interface InAppBrowserToolbarTheme {
  toolbarColor: string;
  toolbarTextColor: string;
}

/**
 * Match the native InAppBrowser chrome to the wallet's resolved light/dark theme.
 * Defaults previously hard-coded white, so dark-mode users saw a light header.
 */
export function getInAppBrowserToolbarTheme(): InAppBrowserToolbarTheme {
  const resolved = resolveTheme(getThemeSetting());
  if (resolved === 'dark') {
    return {
      toolbarColor: '#191919',
      toolbarTextColor: '#FFFFFF'
    };
  }
  return {
    toolbarColor: '#FFFFFF',
    toolbarTextColor: '#3F3F3F'
  };
}

/**
 * Injected into faucet / external webviews so iOS doesn't zoom on input focus
 * and leave the page permanently zoomed after blur (#503).
 */
export const PREVENT_INPUT_ZOOM_SCRIPT = `
(function() {
  if (window.__midenPreventInputZoom) return;
  window.__midenPreventInputZoom = true;

  var content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);

  // Some sites rewrite the viewport after load — keep ours sticky.
  var observer = new MutationObserver(function() {
    if (meta.getAttribute('content') !== content) {
      meta.setAttribute('content', content);
    }
  });
  observer.observe(meta, { attributes: true, attributeFilter: ['content'] });
})();
`;
