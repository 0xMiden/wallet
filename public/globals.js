// Global polyfills for extension pages.
// Must be loaded before any module scripts.
// External file (not inline) to comply with extension CSP.
window.process = window.process || { env: {}, browser: true };
window.global = window.global || window;
