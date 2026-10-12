// Global polyfills for extension pages.
// Must be loaded before any module scripts.
// External file (not inline) to comply with extension CSP.
window.process = window.process || { env: {}, browser: true };
window.global = window.global || window;
// No Buffer stub here. Each page entry (popup, fullpage, sidepanel, options, confirm) installs the real
// `buffer` polyfill with `globalThis.Buffer = globalThis.Buffer || Buffer`, so a stub set here is never
// replaced. The old stub's `from()` ignored the encoding argument and turned a string into an EMPTY
// Uint8Array. `uint8arrays` prefers `globalThis.Buffer.from(string, 'utf-8')` when a global Buffer exists,
// so the WalletConnect relay JWT got an empty payload and the relay closed the socket with code 3000
// ("JWT validation error: EOF while parsing a value"). A bare `Buffer.from(x, 'base64')` returned the
// same empty array (see exportAccountFile in lib/store/index.ts).

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
