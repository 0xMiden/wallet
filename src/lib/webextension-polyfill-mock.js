// Mock for webextension-polyfill on mobile/desktop (non-extension contexts)
// The real module throws "This script should only be loaded in a browser extension"
// which kills the entire app on platforms without chrome.runtime.
module.exports = {
  runtime: { id: null, getURL: (p) => '/' + p, getManifest: () => ({}) },
  i18n: { getMessage: (k) => k, getUILanguage: () => 'en' },
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  tabs: { create: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} }, clear: () => {} },
  notifications: { create: () => {}, clear: () => {}, onClicked: { addListener: () => {} } }
};
