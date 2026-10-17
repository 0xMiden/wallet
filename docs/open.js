'use strict';

const APP_STORE = 'https://apps.apple.com/app/id6789341854';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.miden.wallet';

// Keep in step with src/lib/dapp-browser/open-link.ts: this page must not offer a link the app refuses.
function readTarget() {
  const raw = new URLSearchParams(window.location.search).get('url');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function show(id, href) {
  const element = document.getElementById(id);
  if (href) element.href = href;
  element.hidden = false;
}

const target = readTarget();
const os = platform();

if (target) {
  document.getElementById('host').textContent = target.hostname;
  document.getElementById('title-generic').hidden = true;
  show('title-target');
  show('continue', target.href);
}

if (os !== 'desktop') {
  document.getElementById('stores').hidden = true;
  show('get', os === 'ios' ? APP_STORE : PLAY_STORE);
  if (target) {
    const scheme = 'open?url=' + encodeURIComponent(target.href);
    // An intent URL lets Chrome fall back to the Play listing instead of failing when Bread is missing.
    show(
      'open',
      os === 'ios'
        ? 'com.miden.wallet://' + scheme
        : 'intent://' +
            scheme +
            '#Intent;scheme=com.miden.wallet;package=com.miden.wallet;S.browser_fallback_url=' +
            encodeURIComponent(PLAY_STORE) +
            ';end'
    );
  }
}
