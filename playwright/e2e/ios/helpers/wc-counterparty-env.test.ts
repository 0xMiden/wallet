import { resolveCounterpartyEnv, type WcCounterpartyEnv } from './wc-counterparty-env';
import { WC_PROJECT_ID } from '../../../../src/lib/walletconnect/config';

const DEFAULT_RELAY_URL = 'wss://relay.walletconnect.org';
const DEFAULT_ANVIL_RPC = 'http://127.0.0.1:8545';

// projectId's default is WC_PROJECT_ID itself - config.ts's own trimmed,
// empty-as-unset resolution of the test process's WALLETCONNECT_PROJECT_ID - so
// every case below compares against the import, never a literal, since jest
// loads a developer's .env.
const cases: Array<{ envKey: string; field: keyof WcCounterpartyEnv; default: string }> = [
  { envKey: 'WC_RELAY_URL', field: 'relayUrl', default: DEFAULT_RELAY_URL },
  { envKey: 'WC_COUNTERPARTY_PROJECT_ID', field: 'projectId', default: WC_PROJECT_ID },
  { envKey: 'E2E_EVM_RPC_URL', field: 'anvilRpc', default: DEFAULT_ANVIL_RPC }
];

describe('resolveCounterpartyEnv', () => {
  it('falls back to every default when none of the three variables are set', () => {
    expect(resolveCounterpartyEnv({})).toEqual({
      relayUrl: DEFAULT_RELAY_URL,
      projectId: WC_PROJECT_ID,
      anvilRpc: DEFAULT_ANVIL_RPC
    });
  });

  it.each(cases)('$envKey empty falls back to the default', ({ envKey, field, default: fallback }) => {
    expect(resolveCounterpartyEnv({ [envKey]: '' })[field]).toBe(fallback);
  });

  it.each(cases)('$envKey blank falls back to the default', ({ envKey, field, default: fallback }) => {
    expect(resolveCounterpartyEnv({ [envKey]: '   ' })[field]).toBe(fallback);
  });

  it.each(cases)('$envKey is trimmed', ({ envKey, field }) => {
    expect(resolveCounterpartyEnv({ [envKey]: '  x  ' })[field]).toBe('x');
  });

  it("a blank WC_COUNTERPARTY_PROJECT_ID gives WC_PROJECT_ID, the app's own resolved id", () => {
    expect(resolveCounterpartyEnv({ WC_COUNTERPARTY_PROJECT_ID: '   ' }).projectId).toBe(WC_PROJECT_ID);
  });
});
