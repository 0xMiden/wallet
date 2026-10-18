import { App } from '@capacitor/app';

import { BREAD_REQUEST_SCHEME_URL, BREAD_REQUEST_URL, readLink } from '@miden-sdk/bread-connect';

import { BREAD_CONNECT_TAKEN_KEY } from './keys';

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
  if (read.kind !== 'envelope') return read.id ?? null;
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

let queue: { id: string; link: string }[] = [];
let capturing = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Hold a request link until the wallet can answer it. Each request id is taken once per app session. */
export function acceptRequestLink(link: string): void {
  const canonical = canonicalRequestLink(link);
  const id = requestLinkId(canonical);
  if (id === null || queue.some(held => held.id === id) || takenIds().includes(id)) return;
  queue = [...queue, { id, link: canonical }].slice(-QUEUE_LIMIT);
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
  notify();
  return first.link;
}

/** Start listening for request links, including the one that launched the app. Idempotent. */
export function startRequestLinkCapture(): void {
  if (capturing) return;
  capturing = true;
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
