// Mock for webextension-polyfill on mobile/desktop (non-extension contexts)
// The real module throws "This script should only be loaded in a browser extension"
// which kills the entire app on platforms without chrome.runtime.
module.exports = {
  runtime: { id: null, getURL: p => '/' + p, getManifest: () => ({}) },
  i18n: { getMessage: k => k, getUILanguage: () => 'en' },
  storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  tabs: { create: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} }, clear: () => {} },
  notifications: { create: () => {}, clear: () => {}, onClicked: { addListener: () => {} } },
  // No `data_collection` key, because mobile has no browser-level
  // data-collection consent to report. The telemetry gate never gets here on
  // mobile — it checks `isExtension()` first — but if that check ever drifted,
  // an absent `permissions` would throw and the gate would fail closed, killing
  // telemetry on iOS and Android silently. Answering "no such concept" makes
  // this stub agree with the platform check instead of contradicting it.
  permissions: { getAll: () => Promise.resolve({ permissions: [], origins: [] }) }
};
