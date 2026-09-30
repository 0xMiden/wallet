import { isIP } from 'node:net';
import { z } from 'zod';

import type { FetchLike } from './client.js';
import type { TransakEnv } from '../config.js';

/**
 * Transak pins a widget session to the `x-user-ip` that this server sends. In local development the wallet calls
 * this server over loopback or the LAN, so the caller IP is private, but the widget loads from the public IP of the
 * network. For a private caller IP, this module sends the public IP of this server instead. On one machine or one
 * network, the two public IPs are the same. A public caller IP goes to Transak unchanged.
 * This is for staging only. In production the caller IP always goes to Transak unchanged.
 */

const PUBLIC_IP_LOOKUP_URL = 'https://api.ipify.org?format=json';

const lookupSchema = z.object({ ip: z.string().refine(value => isIP(value) !== 0) });

function isPrivateIpv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split('.').map(Number);
  switch (true) {
    case a === 10:
    case a === 127:
    case a === 169 && b === 254:
    case a === 172 && b >= 16 && b <= 31:
    case a === 192 && b === 168:
    case a === 100 && b >= 64 && b <= 127:
      return true;
    default:
      return false;
  }
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

/** True for loopback, private, link-local and carrier-grade NAT addresses. */
export function isPrivateIp(ip: string): boolean {
  switch (isIP(ip)) {
    case 4:
      return isPrivateIpv4(ip);
    case 6:
      return isPrivateIpv6(ip);
    default:
      return false;
  }
}

export type UserIpResolver = (callerIp: string) => Promise<string>;

/** Send the caller IP unchanged. */
export const passCallerIp: UserIpResolver = callerIp => Promise.resolve(callerIp);

/** The resolver for the Transak environment. Only staging replaces a private caller IP. */
export function userIpResolverFor(env: TransakEnv, fetch: FetchLike): UserIpResolver {
  switch (env) {
    case 'staging':
      return createUserIpResolver(fetch);
    case 'production':
      return passCallerIp;
  }
}

export function createUserIpResolver(fetch: FetchLike): UserIpResolver {
  // One lookup for the life of the process. A failed lookup is not kept, so the next call tries again.
  let publicIp: Promise<string> | null = null;

  async function lookUpPublicIp(): Promise<string> {
    const response = await fetch(PUBLIC_IP_LOOKUP_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`Public IP lookup failed: HTTP ${response.status}`);
    }
    return lookupSchema.parse(await response.json()).ip;
  }

  return callerIp => {
    if (!isPrivateIp(callerIp)) {
      return Promise.resolve(callerIp);
    }
    if (publicIp === null) {
      publicIp = lookUpPublicIp().catch(error => {
        publicIp = null;
        throw error;
      });
    }
    return publicIp;
  };
}
