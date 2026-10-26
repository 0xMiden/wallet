import { resolveCounterpartyEnv, type WcCounterpartyEnv } from './wc-counterparty-env';
import { WC_PROJECT_ID } from '../../../../src/lib/walletconnect/config';

const DEFAULT_RELAY_URL = 'wss://relay.walletconnect.org';
const DEFAULT_ANVIL_RPC = 'http://127.0.0.1:8545';

// projectId's default is WC_PROJECT_ID itself - config.ts's own trimmed,
// empty-as-unset resolution of the test process's WALLETCONNECT_PROJECT_ID - so
// every case below compares against the import, never a literal, since jest
// loads a developer's .env. The isolated cases below pin that fallback to
// config.ts's own export, not a copy of its resolution, by swapping in a
// sentinel WC_PROJECT_ID that only a real import of config.ts can produce.
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

  describe('WC_COUNTERPARTY_PROJECT_ID falls back to config.ts, not a copy of its resolution', () => {
    function loadModule(): typeof import('./wc-counterparty-env') {
      let mod!: typeof import('./wc-counterparty-env');
      jest.isolateModules(() => {
        jest.doMock('../../../../src/lib/walletconnect/config', () => ({ WC_PROJECT_ID: 'from-config-ts' }));
        mod = require('./wc-counterparty-env');
        jest.dontMock('../../../../src/lib/walletconnect/config');
      });
      return mod;
    }

    it.each([{}, { WC_COUNTERPARTY_PROJECT_ID: '' }, { WC_COUNTERPARTY_PROJECT_ID: '   ' }])(
      'projectId resolves through config.ts for env %j',
      env => {
        expect(loadModule().resolveCounterpartyEnv(env).projectId).toBe('from-config-ts');
      }
    );
  });
});
