import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

const mockIsMobile = jest.fn(() => true);
jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile() }));

type NativeRequest = {
  options: { url: string };
  settled: boolean;
  resolve: (value: unknown) => void;
};
const mockNativeRequest = jest.fn();
const mockProbeRequest = jest.fn();
const mockProbeCancel = jest.fn();
const mockBackend = new Map<string, { accounts: string[]; stateCalls: number; path: string }>();
jest.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: (...args: unknown[]) => mockNativeRequest(...args) },
  registerPlugin: jest.fn(() => ({
    request: (...args: unknown[]) => mockProbeRequest(...args),
    cancel: (...args: unknown[]) => mockProbeCancel(...args)
  }))
}));

let mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
const mockEffectiveRpcUrl = 'https://rpc.custom.example';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveRpcUrl: () => mockEffectiveRpcUrl,
  getEffectiveProverUrl: () => undefined,
  getEffectiveNoteTransportUrl: () => undefined
}));

jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: async () => undefined
}));

jest.mock('lib/miden-chain/guardian-registry', () => ({
  ...jest.requireActual('lib/miden-chain/guardian-registry'),
  getKnownGuardians: () => [],
  subscribeGuardians: () => () => undefined
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AuthSecretKey: {
    ecdsaWithRNG: () => ({ commitmentHex: 'commitment', free: jest.fn() })
  },
  Account: {
    deserialize: (bytes: Uint8Array) => {
      const [, accountId, nonce, commitment] = Buffer.from(bytes).toString('utf8').split('|');
      return {
        nonce: () => ({ asInt: () => BigInt(nonce || '0') }),
        id: () => ({ toString: () => accountId }),
        to_commitment: () => ({ toHex: () => commitment }),
        free: jest.fn()
      };
    }
  },
  AccountId: { fromHex: (accountId: string) => accountId },
  Endpoint: class {
    readonly url: string;

    constructor(url: string) {
      this.url = url;
    }
  },
  RpcClient: class {
    private readonly endpoint: unknown;

    constructor(endpoint: unknown) {
      this.endpoint = endpoint;
    }

    async getAccountProof() {
      if (!this.endpoint) throw new Error('RPC endpoint is required');
      return { accountCommitment: () => ({ toHex: () => 'chain-state' }) };
    }
  }
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  EcdsaSigner: class {
    readonly commitment = 'commitment';

    constructor(secretKey: unknown) {
      if (!secretKey) throw new Error('Signer secret key is required');
    }
  }
}));

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    stateCalls = 0;

    constructor(readonly url: string) {}
    setSigner(_signer: unknown) {}

    fetch(path: string, init?: RequestInit) {
      return globalThis.fetch(`${this.url}${path}`, { method: 'GET', signal: init?.signal });
    }

    async lookupAccountByKeyCommitment() {
      const operator = mockBackend.get(this.url)!;
      if (operator.path === 'lookup') await this.fetch('/lookup');
      return { accounts: operator.accounts.map(accountId => ({ accountId })) };
    }

    async getState(accountId: string) {
      const operator = mockBackend.get(this.url)!;
      operator.stateCalls += 1;
      if (operator.path === 'initial-state' || (operator.path === 'settling-state' && operator.stateCalls === 2)) {
        await this.fetch('/state');
      }
      const commitment = operator.path === 'settling-state' && operator.stateCalls > 1 ? 'chain-state' : 'old-state';
      return {
        accountId,
        commitment,
        stateJson: {
          data: Buffer.from(`${this.url}|${accountId}|0|${commitment}`).toString('base64')
        },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
    }

    async getDelta() {
      const operator = mockBackend.get(this.url)!;
      if (operator.path === 'delta') await this.fetch('/delta');
      return { newCommitment: 'chain-state' };
    }
  }
}));

class FakeRequest {
  readonly signal: AbortSignal | undefined;
  constructor(
    readonly url: string,
    init?: { signal?: AbortSignal | null }
  ) {
    this.signal = init?.signal ?? undefined;
  }
}

class FakeResponse {
  constructor(
    readonly body: unknown,
    readonly init: { status: number; statusText?: string; headers?: unknown }
  ) {}
}
Object.assign(globalThis, { Request: FakeRequest, Response: FakeResponse });

const mockWebFetch = jest.fn();
const nativeRequests: NativeRequest[] = [];

function loadModules(): {
  nativeHttp: typeof import('./native-http');
  discover: typeof import('./discover');
} {
  let nativeHttp!: typeof import('./native-http');
  let discover!: typeof import('./discover');
  jest.isolateModules(() => {
    nativeHttp = require('lib/miden/guardian/native-http');
    discover = require('./discover');
  });
  nativeHttp.installGuardianFetchBoundary();
  return { nativeHttp, discover };
}

const makeEndpoints = (path: string, generation: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const endpoint = `https://${generation}-${path}-${index}.example`;
    mockBackend.set(endpoint, {
      accounts: [`${generation}-account-${index}`],
      stateCalls: 0,
      path
    });
    return endpoint;
  });

beforeEach(() => {
  jest.useFakeTimers();
  mockBackend.clear();
  nativeRequests.length = 0;
  mockIsMobile.mockReturnValue(true);
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockWebFetch.mockReset().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    arrayBuffer: async () => new ArrayBuffer(0)
  });
  mockNativeRequest.mockReset().mockImplementation((options: { url: string }) => holdNativeRequest(options));
  mockProbeRequest.mockReset().mockImplementation((options: { url: string }) => holdNativeRequest(options));
  mockProbeCancel.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = mockWebFetch;
});

function holdNativeRequest(options: { url: string }): Promise<unknown> {
  return new Promise(resolve => {
    let request!: NativeRequest;
    request = {
      options,
      settled: false,
      resolve: value => {
        request.settled = true;
        resolve(value);
      }
    };
    nativeRequests.push(request);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('keeps unresolved native reads inside the six-request cap', () => {
  it.each(['lookup', 'initial-state', 'delta', 'settling-state'] as const)(
    'keeps unresolved native reads inside the six-request cap for the %s path',
    async path => {
      const { discover } = loadModules();
      const concurrency = discover.GUARDIAN_PROBE_CONCURRENCY;
      const heldEndpoints = makeEndpoints(path, `held-${path}`, concurrency);
      const heldControllers = heldEndpoints.map(() => new AbortController());
      const heldDiscoveries =
        path === 'lookup' || path === 'initial-state'
          ? [
              discover.discoverGuardianForSeed(() => new Uint8Array([1]), {
                network: MIDEN_NETWORK_NAME.TESTNET,
                endpoints: heldEndpoints,
                maxHdIndex: 1,
                timeoutMs: 30,
                signal: heldControllers[0]!.signal
              })
            ]
          : heldEndpoints.map((endpoint, index) =>
              discover.discoverGuardianForSeed(() => new Uint8Array([1]), {
                network: MIDEN_NETWORK_NAME.TESTNET,
                endpoints: [endpoint],
                maxHdIndex: 1,
                timeoutMs: 30,
                signal: heldControllers[index]!.signal
              })
            );
      let heldDiscoveryFinished = false;
      const heldDiscovery = Promise.all(heldDiscoveries).then(
        results => {
          heldDiscoveryFinished = true;
          return results;
        },
        () => {
          heldDiscoveryFinished = true;
          return [];
        }
      );
      let freshController: AbortController | undefined;
      let freshDiscovery: Promise<unknown> | undefined;

      const flushNativeCalls = async (minimum: number) => {
        for (let index = 0; index < 20 && nativeRequests.length < minimum; index += 1) {
          await jest.advanceTimersByTimeAsync(0);
        }
      };

      try {
        await flushNativeCalls(concurrency);
        expect(nativeRequests).toHaveLength(concurrency);

        const ceiling =
          path === 'lookup' || path === 'initial-state' ? discover.GUARDIAN_PROBE_REQUEST_ATTEMPTS * 30 : 30;
        await jest.advanceTimersByTimeAsync(ceiling);
        expect(nativeRequests).toHaveLength(concurrency);
        expect(mockProbeCancel).toHaveBeenCalledTimes(concurrency);
        for (const endpoint of heldEndpoints) {
          expect(nativeRequests.filter(request => request.options.url.includes(endpoint))).toHaveLength(1);
        }

        if (path !== 'settling-state') await heldDiscovery;
        expect(heldDiscoveryFinished).toBe(path !== 'settling-state');
        expect(
          nativeRequests
            .filter(request => heldEndpoints.some(endpoint => request.options.url.includes(endpoint)))
            .every(request => !request.settled)
        ).toBe(true);

        const freshEndpoint = makeEndpoints(path, `fresh-${path}`, 1)[0]!;
        freshController = new AbortController();
        freshDiscovery = discover.discoverGuardianForSeed(() => new Uint8Array([1]), {
          network: MIDEN_NETWORK_NAME.TESTNET,
          endpoints: [freshEndpoint],
          maxHdIndex: 1,
          timeoutMs: 30,
          signal: freshController.signal
        });
        await flushNativeCalls(concurrency + 1);
        expect(nativeRequests).toHaveLength(concurrency);

        nativeRequests[0]!.resolve({ status: 200, headers: {}, data: '{}' });
        await flushNativeCalls(concurrency + 1);
        expect(nativeRequests).toHaveLength(concurrency + 1);
        expect(nativeRequests[concurrency]?.options.url).toContain(freshEndpoint);
        for (const endpoint of heldEndpoints) {
          expect(nativeRequests.filter(request => request.options.url.includes(endpoint))).toHaveLength(1);
        }
        expect(nativeRequests.filter(request => !request.settled)).toHaveLength(concurrency);
      } finally {
        heldControllers.forEach(controller => controller.abort(new Error('test cleanup')));
        freshController?.abort(new Error('test cleanup'));
        for (const request of nativeRequests) {
          if (!request.settled) request.resolve({ status: 200, headers: {}, data: '{}' });
        }
        await jest.advanceTimersByTimeAsync(0);
        await Promise.allSettled([...heldDiscoveries, heldDiscovery, ...(freshDiscovery ? [freshDiscovery] : [])]);
        await jest.advanceTimersByTimeAsync(0);
      }
    }
  );
});
