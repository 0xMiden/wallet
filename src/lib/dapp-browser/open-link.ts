import { App } from '@capacitor/app';

/**
 * Host of Bread's open links, `https://bread.miden.xyz/open?url=<page>`. The iOS associated-domains
 * entitlement, the Android intent filter and the association files 0xMiden/wallet-link serves all name it too.
 */
export const OPEN_LINK_HOST = 'bread.miden.xyz';
const OPEN_LINK_PATH = '/open';
// Matched as text: Android WebViews before Chromium 130 parse no host out of a custom-scheme URL.
const SCHEME_LINK = /^com\.miden\.wallet:\/\/open\/?(\?[^#]*)?(#.*)?$/i;

// iOS delivers a link that cold-starts the app twice: as the launch URL and as a retained `appUrlOpen` event.
const DUPLICATE_WINDOW_MS = 2_000;

function linkQuery(link: string): URLSearchParams | null {
  const scheme = SCHEME_LINK.exec(link);
  if (scheme) return new URLSearchParams(scheme[1] ?? '');
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname === OPEN_LINK_HOST && url.pathname === OPEN_LINK_PATH
      ? url.searchParams
      : null;
  } catch {
    return null;
  }
}

/**
 * The page an open link asks Bread to show, normalized, or null when `link` is not an open link
 * (`https://bread.miden.xyz/open?url=…` or `com.miden.wallet://open?url=…`) or names a page Bread will
 * not open: only https, and never one with credentials before the host, which is how a URL like
 * `https://wallet.example@evil.example` disguises where it really goes.
 */
export function parseOpenLink(link: string): string | null {
  const raw = linkQuery(link)?.get('url');
  if (!raw) return null;
  try {
    const page = new URL(raw);
    return page.protocol === 'https:' && !page.username && !page.password ? page.href : null;
  } catch {
    return null;
  }
}

// A reload starts this module afresh; sessionStorage keeps the held link and the links already taken.
const PENDING_KEY = 'open-link:pending';
const TAKEN_KEY = 'open-link:taken';
const TAKEN_LIMIT = 20;

function stored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Without storage a reload forgets the held link and can offer a taken launch link again.
  }
}

function takenLinks(): unknown[] {
  try {
    const taken: unknown = JSON.parse(stored(TAKEN_KEY) ?? '[]');
    return Array.isArray(taken) ? taken : [];
  } catch {
    return [];
  }
}

let pending: { link: string; page: string } | null = null;
let lastAccepted: { link: string; at: number } | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Hold the page `link` names until the wallet can open it. The newest link wins. */
export function acceptOpenLink(link: string, now = Date.now()): void {
  const page = parseOpenLink(link);
  if (!page) return;
  if (lastAccepted?.link === link && now - lastAccepted.at < DUPLICATE_WINDOW_MS) return;
  lastAccepted = { link, at: now };
  pending = { link, page };
  store(PENDING_KEY, link);
  notify();
}

export function getPendingOpenLink(): string | null {
  return pending?.page ?? null;
}

export function subscribePendingOpenLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear and return the held page: the caller now opens it or has dropped it. */
export function takePendingOpenLink(): string | null {
  if (!pending) return null;
  const { link, page } = pending;
  pending = null;
  store(PENDING_KEY, null);
  store(TAKEN_KEY, JSON.stringify([...takenLinks().filter(taken => taken !== link), link].slice(-TAKEN_LIMIT)));
  notify();
  return page;
}

let capturing = false;
// The launch URL outlives its link (iOS reports the last link the app was opened with, even after a reload), so
// it counts only while no newer link is held.
let launchSuperseded = false;

/** Start listening for open links, including the one that launched the app. Idempotent. */
export function startOpenLinkCapture(): void {
  if (capturing) return;
  capturing = true;
  const held = stored(PENDING_KEY);
  if (held && parseOpenLink(held)) {
    launchSuperseded = true;
    acceptOpenLink(held);
  }
  App.addListener('appUrlOpen', ({ url }) => {
    if (parseOpenLink(url)) launchSuperseded = true;
    acceptOpenLink(url);
  }).catch(error => {
    console.warn('[open-link] appUrlOpen listener failed:', error);
  });
  App.getLaunchUrl()
    .then(launch => {
      if (launch?.url && !launchSuperseded && !takenLinks().includes(launch.url)) acceptOpenLink(launch.url);
    })
    .catch(error => {
      console.warn('[open-link] getLaunchUrl failed:', error);
    });
}

export function __resetOpenLinksForTest(): void {
  pending = null;
  lastAccepted = null;
  capturing = false;
  launchSuperseded = false;
  listeners.clear();
}
