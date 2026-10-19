import { App } from '@capacitor/app';

import {
  BREAD_REQUEST_SCHEME_URL,
  BREAD_REQUEST_URL,
  isRecord,
  readLink,
  REQUEST_MAX_AGE_MS
} from '@miden-sdk/bread-connect';

import { BREAD_CONNECT_QUEUE_KEY, BREAD_CONNECT_TAKEN_KEY } from './keys';

const TAKEN_LIMIT = 200;
const QUEUE_LIMIT = 10;

/** The https form of a request link. The page bread.miden.xyz/request serves hands Bread the same fragment under Bread's scheme. */
export function canonicalRequestLink(link: string): string {
  return link.startsWith(`${BREAD_REQUEST_SCHEME_URL}#`)
    ? BREAD_REQUEST_URL + link.slice(BREAD_REQUEST_SCHEME_URL.length)
    : link;
}

/** The id Bread answers a request link under, or null when the link is not one Bread can answer. */
export function requestLinkId(link: string): string | null {
  const read = readLink(link, BREAD_REQUEST_URL);
  if (!read) return null;
  if (read.kind !== 'envelope') return read.callback && read.id ? read.id : null;
  return read.envelope.type === 'connect' || read.envelope.type === 'request' ? read.envelope.id : null;
}

function takenIds(): string[] {
  try {
    const taken: unknown = JSON.parse(sessionStorage.getItem(BREAD_CONNECT_TAKEN_KEY) ?? '[]');
    return Array.isArray(taken) ? taken.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberTaken(id: string): void {
  try {
    sessionStorage.setItem(
      BREAD_CONNECT_TAKEN_KEY,
      JSON.stringify([...takenIds().filter(taken => taken !== id), id].slice(-TAKEN_LIMIT))
    );
  } catch {
    // Without storage a reload can take the launch link again, and Bread refuses its id as already answered.
  }
}

interface HeldLink {
  id: string;
  link: string;
  at: number;
}

let queue: HeldLink[] = [];
let capturing = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function storeQueue(): void {
  try {
    if (queue.length === 0) localStorage.removeItem(BREAD_CONNECT_QUEUE_KEY);
    else localStorage.setItem(BREAD_CONNECT_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Without storage the held links last only until the system stops the app.
  }
}

/** The links held before the app restarted that Bread can still answer: none taken, none past a request's age. */
function storedQueue(now: number): HeldLink[] {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(BREAD_CONNECT_QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const taken = takenIds();
  return stored.filter(
    (held): held is HeldLink =>
      isRecord(held) &&
      typeof held.id === 'string' &&
      typeof held.link === 'string' &&
      typeof held.at === 'number' &&
      now - held.at <= REQUEST_MAX_AGE_MS &&
      !taken.includes(held.id) &&
      requestLinkId(held.link) === held.id
  );
}

/** Hold a request link until the wallet can answer it. Each request id is taken once per app session. */
export function acceptRequestLink(link: string): void {
  const canonical = canonicalRequestLink(link);
  const id = requestLinkId(canonical);
  if (id === null || queue.some(held => held.id === id) || takenIds().includes(id)) return;
  queue = [...queue, { id, link: canonical, at: Date.now() }].slice(-QUEUE_LIMIT);
  storeQueue();
  notify();
}

export function nextRequestLink(): string | null {
  return queue[0]?.link ?? null;
}

export function subscribeRequestLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear and return the oldest held link: the caller now answers it. */
export function takeRequestLink(): string | null {
  const [first, ...rest] = queue;
  if (!first) return null;
  queue = rest;
  rememberTaken(first.id);
  storeQueue();
  notify();
  return first.link;
}

/**
 * Start listening for request links, including the one that launched the app, and hold again the links held when
 * the system stopped the app, as it may while the user unlocks or sets up the wallet. Idempotent.
 */
export function startRequestLinkCapture(): void {
  if (capturing) return;
  capturing = true;
  const restored = storedQueue(Date.now()).filter(held => !queue.some(live => live.id === held.id));
  queue = [...restored, ...queue].slice(-QUEUE_LIMIT);
  storeQueue();
  if (restored.length > 0) notify();
  App.addListener('appUrlOpen', ({ url }) => acceptRequestLink(url)).catch(error => {
    console.warn('[bread-connect] appUrlOpen listener failed:', error);
  });
  App.getLaunchUrl()
    .then(launch => {
      if (launch?.url) acceptRequestLink(launch.url);
    })
    .catch(error => {
      console.warn('[bread-connect] getLaunchUrl failed:', error);
    });
}

export function __resetRequestLinksForTest(): void {
  queue = [];
  capturing = false;
  listeners.clear();
}
