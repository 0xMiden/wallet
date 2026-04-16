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

