// Global polyfills for extension pages.
// Must be loaded before any module scripts.
// External file (not inline) to comply with extension CSP.
window.process = window.process || { env: {}, browser: true };
window.global = window.global || window;
// Buffer polyfill will be set by the first module that imports 'buffer'
// For now, set a stub that will be overridden
if (typeof window.Buffer === 'undefined') {
  window.Buffer = { isBuffer: function() { return false; }, from: function(a) { return new Uint8Array(a); } };
}

// Pre-React theme bootstrap. Reads the same localStorage key the React
// `applyTheme` helper writes (`theme_setting` / 'light' | 'dark' | 'system')
// and applies `.dark` + the dark background on <html> before first paint —
// so reopening the popup or side panel in dark mode doesn't flash the
// browser's default white before React mounts and runs initTheme().
// Lives in globals.js (external) because MV3 CSP forbids inline scripts.
(function () {
  try {
    var s = localStorage.getItem('theme_setting') || 'system';
    var dark =
      s === 'dark' ||
      (s === 'system' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.backgroundColor = '#191919';
    }
  } catch (e) {}
})();

