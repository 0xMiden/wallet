/**
 * Coverage tests for `lib/miden-chain/constants.ts`.
 */

const mockEndpoint = jest.fn();
const mockMidenClientReady = jest.fn(() => Promise.resolve());

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Endpoint: function (url: string) {
    return mockEndpoint(url);
  },
  NetworkId: {
    mainnet: () => ({ kind: 'mainnet' }),
    devnet: () => ({ kind: 'devnet' }),
    testnet: () => ({ kind: 'testnet' }),
    custom: (prefix: string) => ({ kind: 'custom', prefix })
  },
  MidenClient: {
    ready: mockMidenClientReady
  }
}));

const ORIGINAL_ENV = process.env;

describe('miden-chain/constants', () => {
  beforeEach(() => {
    jest.resetModules();
    mockEndpoint.mockReset();
    mockMidenClientReady.mockReset();
    mockMidenClientReady.mockReturnValue(Promise.resolve());
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('getNetworkId returns a NetworkId', () => {
    jest.isolateModules(() => {
      const { getNetworkId } = require('./constants');
      const id = getNetworkId();
      expect(id).toBeDefined();
    });
  });

  it('getRpcEndpoint constructs an Endpoint for the current network', () => {
    mockEndpoint.mockReturnValue({ ok: true });
    jest.isolateModules(() => {
      const { getRpcEndpoint } = require('./constants');
      getRpcEndpoint();
    });
    expect(mockEndpoint).toHaveBeenCalledTimes(1);
    expect(mockEndpoint.mock.calls[0][0]).toMatch(/^https?:\/\//);
  });

  describe('getGuardianOptionsForNetwork', () => {
    it('resolves providers to their endpoint on the network, OpenZeppelin first', () => {
      jest.isolateModules(() => {
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.TESTNET);
        // More than one provider runs on testnet; opts[0] is the default (OpenZeppelin),
        // resolved to its TESTNET endpoint (pins provider identity + per-network endpoint).
        expect(opts.length).toBeGreaterThan(1);
        expect(opts[0]).toMatchObject({ id: 'open-zeppelin', endpoint: 'https://guardian-testnet.openzeppelin.com' });
      });
    });

    it('filters to the subset running on the network and resolves that network endpoint', () => {
      jest.isolateModules(() => {
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        // Only OpenZeppelin runs a devnet guardian -> exactly one option, its devnet endpoint.
        expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.DEVNET)).toEqual([
          {
            id: 'open-zeppelin',
            name: 'OpenZeppelin',
            operatedBy: 'OpenZeppelin',
            location: 'US-EAST',
            endpoint: 'https://guardian-devnet.openzeppelin.com'
          }
        ]);
      });
    });

    it('returns an empty list for a network with no guardian providers', () => {
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
        setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
        expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.MAINNET)).toEqual([]);
      });
    });

    it('offers a custom Guardian URL only on the network it was set on', async () => {
      process.env.MIDEN_NETWORK = 'testnet';
      let constants!: typeof import('./constants');
      let endpoints!: typeof import('./effective-endpoints');
      jest.isolateModules(() => {
        constants = require('./constants');
        endpoints = require('./effective-endpoints');
      });
      const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = constants;
      const override = endpoints.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
      override.guardianUrl = 'https://custom.guardian.example';
      // The override lives in this test's module registry only: the storage stub keeps nothing.
      await endpoints.applyEndpointOverride(override);

      expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.TESTNET)).toContainEqual(
        expect.objectContaining({ id: 'custom', endpoint: 'https://custom.guardian.example' })
      );
      // A recovery into mainnet from this testnet wallet must never probe or register the testnet override.
      expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.MAINNET).map(option => option.id)).not.toContain('custom');
      expect(getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.DEVNET).map(option => option.id)).not.toContain('custom');
    });

    describe('localnet second guardian (E2E only)', () => {
      const prev = process.env.MIDEN_E2E_TEST;
      afterEach(() => {
        process.env.MIDEN_E2E_TEST = prev;
      });

      it('exposes OpenZeppelin B on localnet only under MIDEN_E2E_TEST', () => {
        process.env.MIDEN_E2E_TEST = 'true';
        jest.isolateModules(() => {
          const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
          const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
          expect(opts.map((o: { endpoint: string }) => o.endpoint)).toContain('http://localhost:3001');
          // The E2E-only operator must use the canonical brand spelling too (#464).
          const ozB = opts.find((o: { endpoint: string }) => o.endpoint === 'http://localhost:3001');
          expect(ozB?.name).toBe('OpenZeppelin B');
          expect(ozB?.operatedBy).toBe('OpenZeppelin');
        });
      });

      it('hides OpenZeppelin B when not in E2E', () => {
        process.env.MIDEN_E2E_TEST = 'false';
        jest.isolateModules(() => {
          const { getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } = require('./constants');
          const opts = getGuardianOptionsForNetwork(MIDEN_NETWORK_NAME.LOCALNET);
          expect(opts.map((o: { endpoint: string }) => o.endpoint)).not.toContain('http://localhost:3001');
        });
      });
    });
  });

  describe('ensureSdkWasmReady', () => {
    it('delegates to MidenClient.ready()', async () => {
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        await expect(ensureSdkWasmReady()).resolves.toBeUndefined();
      });
      expect(mockMidenClientReady).toHaveBeenCalledTimes(1);
    });

    it('propagates rejections from MidenClient.ready()', async () => {
      const failure = new Error('wasm boom');
      mockMidenClientReady.mockReturnValueOnce(Promise.reject(failure));
      await jest.isolateModulesAsync(async () => {
        const { ensureSdkWasmReady } = require('./constants');
        const { snapshotCrashDiagnostics } = require('lib/telemetry/crash-diagnostics');
        await expect(ensureSdkWasmReady()).rejects.toBe(failure);
        expect(snapshotCrashDiagnostics(failure)).toEqual({ operation: 'sdk_initialize', stage: 'wasm_ready' });
      });
    });
  });

  describe('getExplorerTxUrl', () => {
    it('returns the explorer URL when the network has an entry', () => {
      jest.isolateModules(() => {
        const { getExplorerTxUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerTxUrl('0xabc', MIDEN_NETWORK_NAME.TESTNET)).toBe('https://testnet.midenscan.com/tx/0xabc');
      });
    });

    it('returns the mainnet explorer URL for mainnet', () => {
      jest.isolateModules(() => {
        const { getExplorerTxUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerTxUrl('0xabc', MIDEN_NETWORK_NAME.MAINNET)).toBe('https://explorer.mainnet.miden.io/tx/0xabc');
      });
    });

    it('returns undefined when the network has no explorer mapping', () => {
      jest.isolateModules(() => {
        const { getExplorerTxUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerTxUrl('0xabc', MIDEN_NETWORK_NAME.LOCALNET)).toBeUndefined();
      });
    });

    it('falls back to DEFAULT_NETWORK when no network is provided', () => {
      delete process.env.MIDEN_NETWORK;
      jest.isolateModules(() => {
        const { getExplorerTxUrl } = require('./constants');
        expect(getExplorerTxUrl('0xabc')).toBe('https://testnet.midenscan.com/tx/0xabc');
      });
    });
  });

  describe('getExplorerAccountUrl', () => {
    it('returns the account explorer URL when the network has an entry', () => {
      jest.isolateModules(() => {
        const { getExplorerAccountUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerAccountUrl('mtst1acc', MIDEN_NETWORK_NAME.TESTNET)).toBe(
          'https://testnet.midenscan.com/account/mtst1acc'
        );
      });
    });

    it('returns the mainnet account explorer URL for mainnet', () => {
      jest.isolateModules(() => {
        const { getExplorerAccountUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerAccountUrl('mm1acc', MIDEN_NETWORK_NAME.MAINNET)).toBe(
          'https://explorer.mainnet.miden.io/account/mm1acc'
        );
      });
    });

    it('returns undefined when the network has no explorer mapping', () => {
      jest.isolateModules(() => {
        const { getExplorerAccountUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getExplorerAccountUrl('mlcl1acc', MIDEN_NETWORK_NAME.LOCALNET)).toBeUndefined();
      });
    });

    it('falls back to DEFAULT_NETWORK when no network is provided', () => {
      delete process.env.MIDEN_NETWORK;
      jest.isolateModules(() => {
        const { getExplorerAccountUrl } = require('./constants');
        expect(getExplorerAccountUrl('mtst1acc')).toBe('https://testnet.midenscan.com/account/mtst1acc');
      });
    });
  });

  // The override-respect path (custom explorer URL wins over the build default)
  // is proven end-to-end in effective-endpoints.test.ts, where applyEndpointOverride
  // + the in-memory storage mock exercise the real getEffectiveExplorerUrl the two
  // helpers above delegate to.

  describe('getNoteTransportUrl', () => {
    it('returns the per-network endpoint when no override is set', () => {
      delete process.env.MIDEN_NOTE_TRANSPORT_URL;
      jest.isolateModules(() => {
        const { getNoteTransportUrl, MIDEN_NETWORK_NAME } = require('./constants');
        expect(getNoteTransportUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe('https://transport.miden.io');
      });
    });

    it('returns undefined for an unknown network when no override is set', () => {
      delete process.env.MIDEN_NOTE_TRANSPORT_URL;
      jest.isolateModules(() => {
        const { getNoteTransportUrl } = require('./constants');
        expect(getNoteTransportUrl('not-a-network')).toBeUndefined();
      });
    });

    it('returns the build-time override when MIDEN_NOTE_TRANSPORT_URL is set', () => {
      process.env.MIDEN_NOTE_TRANSPORT_URL = 'http://localhost:57292';
      jest.isolateModules(() => {
        const { getNoteTransportUrl, MIDEN_NETWORK_NAME } = require('./constants');
        // Override wins regardless of network mapping.
        expect(getNoteTransportUrl(MIDEN_NETWORK_NAME.TESTNET)).toBe('http://localhost:57292');
        expect(getNoteTransportUrl('not-a-network')).toBe('http://localhost:57292');
      });
    });
  });

  describe('DEFAULT_NETWORK', () => {
    it('falls back to TESTNET when MIDEN_NETWORK env is unset', () => {
      delete process.env.MIDEN_NETWORK;
      jest.isolateModules(() => {
        const { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } = require('./constants');
        expect(DEFAULT_NETWORK).toBe(MIDEN_NETWORK_NAME.TESTNET);
      });
    });

    it('honors MIDEN_NETWORK env when set', () => {
      process.env.MIDEN_NETWORK = 'devnet';
      jest.isolateModules(() => {
        const { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } = require('./constants');
        expect(DEFAULT_NETWORK).toBe(MIDEN_NETWORK_NAME.DEVNET);
      });
    });
  });

  describe('getDefaultGuardianEndpoint', () => {
    it('returns the endpoint for a supported network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { getDefaultGuardianEndpoint } = require('./constants');
        expect(getDefaultGuardianEndpoint()).toBe('https://guardian-testnet.openzeppelin.com');
      });
    });

    it('throws (rather than targeting staging) on a network with no operator', () => {
      process.env.MIDEN_NETWORK = 'mainnet';
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        const { getDefaultGuardianEndpoint } = require('./constants');
        setDocumentGuardians('mainnet', []);
        expect(() => getDefaultGuardianEndpoint()).toThrow('Guardian is not available on network "mainnet"');
      });
    });
  });

  describe('GUARDIAN_OPTIONS', () => {
    it('offers more than one provider, each mapping networks to valid https endpoints', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { GUARDIAN_OPTIONS } = require('./constants');
        expect(GUARDIAN_OPTIONS.length).toBeGreaterThan(1);
        for (const option of GUARDIAN_OPTIONS) {
          expect(option.id).toBeTruthy();
          expect(option.endpoint.size).toBeGreaterThan(0);
          for (const url of option.endpoint.values()) {
            expect(() => new URL(url)).not.toThrow();
            // https everywhere, except the localnet dev guardian (http on localhost).
            expect(url.startsWith('https://') || url.startsWith('http://localhost:')).toBe(true);
          }
        }
      });
    });

    it('exposes the OpenZeppelin endpoint per network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { GUARDIAN_OPTIONS } = require('./constants');
        const oz = GUARDIAN_OPTIONS.find((o: { id: string }) => o.id === 'open-zeppelin');
        expect(oz?.endpoint.get('testnet')).toBe('https://guardian-testnet.openzeppelin.com');
        expect(oz?.endpoint.get('devnet')).toBe('https://guardian-devnet.openzeppelin.com');
      });
    });
  });

  describe('getGuardianEndpointsForNetwork', () => {
    it('collects every bundled provider endpoint per network, OpenZeppelin first, with no config document', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { getGuardianEndpointsForNetwork } = require('./constants');
        expect(getGuardianEndpointsForNetwork('testnet')).toEqual([
          'https://guardian-testnet.openzeppelin.com',
          'https://miden-guardian.dev.eu-north-3.gateway.fm',
          'https://miden-guardian.lambdaclass.com',
          'https://guardian-testnet.kodax.com',
          'https://miden-guardian.beta.getpara.com'
        ]);
        // Only OpenZeppelin runs a devnet Guardian.
        expect(getGuardianEndpointsForNetwork('devnet')).toEqual(['https://guardian-devnet.openzeppelin.com']);
        // OpenZeppelin also exposes a localnet endpoint (the local guardian image).
        expect(getGuardianEndpointsForNetwork('localnet')).toEqual(['http://localhost:3000']);
        // Mainnet has its own LambdaClass operator and never borrows another network's.
        expect(getGuardianEndpointsForNetwork('mainnet')).toEqual(['https://guardian.cedar.internal.lambdaclass.com']);
        // The default is the effective network.
        expect(getGuardianEndpointsForNetwork()).toEqual(getGuardianEndpointsForNetwork('testnet'));
      });
    });

    it('reads the config document list in place of the bundled one, in every getter', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        const {
          getBuiltInGuardianOptionsForNetwork,
          getDefaultGuardianEndpoint,
          getGuardianEndpointsForNetwork,
          getGuardianOptionsForNetwork
        } = require('./constants');
        const listed = [
          { id: 'kodax', name: 'Koda', operatedBy: 'Koda', location: 'Asia', endpoint: 'https://koda.example' },
          { id: 'new-one', name: 'New', operatedBy: 'New Co', location: 'EU', endpoint: 'https://new.example' }
        ];
        setDocumentGuardians('testnet', listed);

        expect(getGuardianEndpointsForNetwork('testnet')).toEqual(['https://koda.example', 'https://new.example']);
        expect(getBuiltInGuardianOptionsForNetwork('testnet')).toEqual(listed);
        expect(getGuardianOptionsForNetwork('testnet')).toEqual(listed);
        // The first listed operator is the default; OpenZeppelin, which the document does not list, is gone.
        expect(getDefaultGuardianEndpoint()).toBe('https://koda.example');
        // Another network keeps its own list.
        expect(getGuardianEndpointsForNetwork('devnet')).toEqual(['https://guardian-devnet.openzeppelin.com']);
      });
    });
  });

  describe('isOtherNetworkGuardian', () => {
    const cases: Array<[string, string, string, boolean]> = [
      ['a testnet operator on mainnet', 'https://guardian-testnet.openzeppelin.com', 'mainnet', true],
      ['a testnet operator under its old name on mainnet', 'https://guardian.openzeppelin.com/', 'mainnet', true],
      ['a devnet operator on testnet', 'https://guardian-devnet.openzeppelin.com', 'testnet', true],
      ['a testnet operator on testnet', 'https://guardian-testnet.openzeppelin.com', 'testnet', false],
      ['an operator no network lists', 'https://guardian.example', 'mainnet', false],
      ['a local operator on testnet', 'http://localhost:3000', 'testnet', false]
    ];

    it.each(cases)('answers for %s', (_case, endpoint, network, expected) => {
      jest.isolateModules(() => {
        const { isOtherNetworkGuardian } = require('./constants');
        expect(isOtherNetworkGuardian(endpoint, network)).toBe(expected);
      });
    });

    it('reads each network from its config document list', () => {
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        const { isOtherNetworkGuardian } = require('./constants');
        const mainnetOperator = {
          id: 'mainnet-operator',
          name: 'Mainnet Operator',
          operatedBy: 'Operator Co',
          location: 'EU',
          endpoint: 'https://guardian-mainnet.example'
        };
        setDocumentGuardians('mainnet', [mainnetOperator]);

        expect(isOtherNetworkGuardian(mainnetOperator.endpoint, 'mainnet')).toBe(false);
        expect(isOtherNetworkGuardian(mainnetOperator.endpoint, 'testnet')).toBe(true);
      });
    });

    it('counts an operator both networks list as belonging to this one', () => {
      jest.isolateModules(() => {
        const { setDocumentGuardians } = require('./guardian-registry');
        const { isOtherNetworkGuardian } = require('./constants');
        const shared = 'https://guardian-testnet.openzeppelin.com';
        setDocumentGuardians('mainnet', [
          { id: 'open-zeppelin', name: 'OpenZeppelin', operatedBy: 'OpenZeppelin', location: 'US', endpoint: shared }
        ]);

        expect(isOtherNetworkGuardian(shared, 'mainnet')).toBe(false);
      });
    });
  });

  describe('getNetworkId', () => {
    it('returns testnet for TESTNET network', () => {
      process.env.MIDEN_NETWORK = 'testnet';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        expect(getNetworkId()).toEqual({ kind: 'testnet' });
      });
    });

    it('returns the localnet custom prefix (mlcl) for LOCALNET network', () => {
      process.env.MIDEN_NETWORK = 'localnet';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        // The SDK has no localnet() constructor; localnet uses the 'mlcl' HRP.
        // Previously LOCALNET wrongly fell through to testnet() (mtst1 prefix).
        expect(getNetworkId()).toEqual({ kind: 'custom', prefix: 'mlcl' });
      });
    });

    it('falls through to testnet for unknown networks', () => {
      process.env.MIDEN_NETWORK = 'something-unknown';
      jest.isolateModules(() => {
        const { getNetworkId } = require('./constants');
        expect(getNetworkId()).toEqual({ kind: 'testnet' });
      });
    });
  });

  describe('resolveNetworkName', () => {
    it("maps the E2E 'localhost' token to the LOCALNET enum", () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName('localhost')).toBe(MIDEN_NETWORK_NAME.LOCALNET);
      });
    });
    it('passes through valid enum values', () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName('devnet')).toBe(MIDEN_NETWORK_NAME.DEVNET);
        expect(resolveNetworkName('localnet')).toBe(MIDEN_NETWORK_NAME.LOCALNET);
      });
    });
    it('defaults to testnet for undefined or unknown', () => {
      jest.isolateModules(() => {
        const { resolveNetworkName, MIDEN_NETWORK_NAME } = require('./constants');
        expect(resolveNetworkName(undefined)).toBe(MIDEN_NETWORK_NAME.TESTNET);
        expect(resolveNetworkName('bogus')).toBe(MIDEN_NETWORK_NAME.TESTNET);
      });
    });
  });
});
