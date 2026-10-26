import { WC_PROJECT_ID } from '../../../../src/lib/walletconnect/config';

/**
 * Env defaults for the headless WalletConnect counterparty (wc-counterparty.ts):
 * WC_RELAY_URL, WC_COUNTERPARTY_PROJECT_ID and E2E_EVM_RPC_URL, each trimmed and
 * treated as unset when empty or blank. WC_COUNTERPARTY_PROJECT_ID falls back to
 * WC_PROJECT_ID - config.ts's own trimmed, empty-as-unset resolution of the test
 * process's own env. Dependency-free (this is the only import) so jest loads it
 * without pulling in @walletconnect or viem.
 */
export interface WcCounterpartyEnv {
  relayUrl: string;
  projectId: string;
  anvilRpc: string;
}

const trimmedOrUnset = (value: string | undefined): string => (value ?? '').trim();

export function resolveCounterpartyEnv(env: Record<string, string | undefined> = process.env): WcCounterpartyEnv {
  return {
    relayUrl: trimmedOrUnset(env.WC_RELAY_URL) || 'wss://relay.walletconnect.org',
    projectId: trimmedOrUnset(env.WC_COUNTERPARTY_PROJECT_ID) || WC_PROJECT_ID,
    anvilRpc: trimmedOrUnset(env.E2E_EVM_RPC_URL) || 'http://127.0.0.1:8545'
  };
}
