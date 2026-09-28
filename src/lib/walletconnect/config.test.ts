function loadModule(): typeof import('./config') {
  let mod!: typeof import('./config');
  jest.isolateModules(() => {
    mod = require('./config');
  });
  return mod;
}

// Read at module load, so every case controls them: jest loads a developer's .env, and an E2E
// RPC override would replace the WalletConnect RPC URL these cases read.
const VARS = ['WALLETCONNECT_PROJECT_ID', 'MIDEN_E2E_TEST', 'E2E_EVM_RPC_URL'] as const;

describe('WC_PROJECT_ID resolution', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('ships the published default project id', () => {
    expect(loadModule().DEFAULT_WC_PROJECT_ID).toBe('d18d112eb50cbe764f03e51a90210611');
  });

  it('falls back to the default when WALLETCONNECT_PROJECT_ID is unset', () => {
    const m = loadModule();
    expect(m.WC_PROJECT_ID).toBe('d18d112eb50cbe764f03e51a90210611');
    expect(m.SUPPORTED_CHAINS[0]!.rpcUrl).toContain('projectId=d18d112eb50cbe764f03e51a90210611');
  });

  it('falls back to the default when WALLETCONNECT_PROJECT_ID is empty', () => {
    process.env.WALLETCONNECT_PROJECT_ID = '';
    expect(loadModule().WC_PROJECT_ID).toBe('d18d112eb50cbe764f03e51a90210611');
  });

  it('falls back to the default when WALLETCONNECT_PROJECT_ID is blank', () => {
    process.env.WALLETCONNECT_PROJECT_ID = '   ';
    expect(loadModule().WC_PROJECT_ID).toBe('d18d112eb50cbe764f03e51a90210611');
  });

  it('uses the trimmed WALLETCONNECT_PROJECT_ID when it is set', () => {
    process.env.WALLETCONNECT_PROJECT_ID = '  abc123def  ';
    const m = loadModule();
    expect(m.WC_PROJECT_ID).toBe('abc123def');
    expect(m.SUPPORTED_CHAINS[0]!.rpcUrl).toContain('projectId=abc123def');
  });
});
