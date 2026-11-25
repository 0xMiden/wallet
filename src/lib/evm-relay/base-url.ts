import { getRelayConfig } from 'lib/remote-config/values';

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * The `MIDEN_EVM_RELAY_URL` build define without a trailing slash, when it is an `http` URL on a loopback host: a
 * local Worker for development. Any other value is ignored.
 */
function loopbackOverride(): string | null {
  const raw = process.env.MIDEN_EVM_RELAY_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) ? trimmed : null;
}

/**
 * The base URL of the deposit relay (`services/evm-relay`), without a trailing slash. A loopback
 * `MIDEN_EVM_RELAY_URL` build define goes first, so a local Worker works on every network. Else the accepted
 * wallet-config document supplies it (`relay.baseUrl` while `features.relayDeposit` is on). Null disables the relay.
 * This reads the realm's snapshot as it is.
 */
export function getRelayBaseUrl(): string | null {
  return loopbackOverride() ?? getRelayConfig()?.baseUrl ?? null;
}
