import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { parse } from 'tldts';

import { MidenDAppErrorType } from 'lib/adapter/types';

/** The kind of root a login key comes from: an account's EVM key. The info layout names it, so it is frozen with v1. */
export type LoginKeySource = 'evm';

// The salt is frozen once released, as are the info layout, the counter rule, the secure-page rule and the domain rule
// below: changing any of them changes every account's login key on every site. The domain rule reads the
// Public Suffix List bundled in tldts, so a tldts upgrade that changes a site's suffix changes that site's login keys.
const LOGIN_KEY_SALT = utf8ToBytes('Bread login key');
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The domain a page's login key belongs to: the registrable domain of `origin`, with the Public Suffix List's private
 * section counted, or the whole host when it has none (an IP address, `localhost`). A trailing dot is dropped from the
 * host, since it names the same host. Only an https page, or an http page on a loopback host, has one.
 */
export function loginKeyDomain(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${MidenDAppErrorType.InvalidParams}: not an origin`);
  }
  let host = url.hostname.toLowerCase();
  // tldts drops trailing dots for its own lookup, so the whole host has to as well.
  while (host.endsWith('.')) host = host.slice(0, -1);
  const isSecure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(host));
  if (!isSecure) throw new Error(`${MidenDAppErrorType.InvalidParams}: login keys need an https page`);
  if (!host) throw new Error(`${MidenDAppErrorType.InvalidParams}: not an origin`);
  const { isIp, domain } = parse(host, { allowPrivateDomains: true });
  return isIp || !domain ? host : domain;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/**
 * The secp256k1 scalar (32 bytes, big-endian, 0 < k < n) of the login key `root` gives on `domain`. `expand` defaults
 * to HKDF-SHA256 over `root`; only tests replace it, to reach the retry.
 */
export function deriveLoginKeyScalar(
  root: Uint8Array,
  source: LoginKeySource,
  domain: string,
  expand: (info: Uint8Array) => Uint8Array = info => hkdf(sha256, root, LOGIN_KEY_SALT, info, 32)
): Uint8Array {
  const prefix = utf8ToBytes(`v1\0${source}\0${domain}\0`);
  for (let counter = 0; counter <= 255; counter++) {
    const info = new Uint8Array(prefix.length + 1);
    info.set(prefix);
    info[prefix.length] = counter;
    const scalar = expand(info);
    const k = BigInt(`0x${bytesToHex(scalar)}`);
    if (k > 0n && k < SECP256K1_ORDER) return scalar;
  }
  throw new Error(`${MidenDAppErrorType.LoginKeyUnavailable}: no valid login key`);
}
