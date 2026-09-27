/**
 * The mobile fetch interceptor routes a Guardian's origin through CapacitorHttp and every other
 * request through the WebView's own fetch. Two rules keep binary traffic off CapacitorHttp: an
 * origin the app itself fetches from never routes, judged per request, and an origin only probed
 * routes while its probe is in flight.
 */
const mockIsMobile = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

const mockNativeRequest = jest.fn();
jest.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: (...args: unknown[]) => mockNativeRequest(...args) }
}));

jest.mock('lib/miden-chain/constants', () => ({
  GUARDIAN_OPTIONS: [{ endpoint: new Map([['testnet', 'https://builtin.guardian.test']]) }]
}));

let mockRpcUrl = 'https://rpc.test';
let mockProverUrl: string | undefined = 'https://prover.test';
let mockNoteTransportUrl: string | undefined = 'https://transport.test';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockRpcUrl,
  getEffectiveProverUrl: () => mockProverUrl,
  getEffectiveNoteTransportUrl: () => mockNoteTransportUrl
}));

// jsdom has no fetch classes: the interceptor needs `Request` for an instanceof check and
// `Response` to wrap a native answer.
class FakeRequest {}
class FakeResponse {
  constructor(
    readonly body: string | null,
    readonly init: { status: number }
  ) {}
}
Object.assign(globalThis, { Request: FakeRequest, Response: FakeResponse });

const BUILTIN = 'https://builtin.guardian.test';
const CUSTOM = 'https://custom.guardian.test';

// `installed` and both origin sets are module state, so every test loads a fresh copy.
function loadNativeHttp(): typeof import('./native-http') {
  let mod!: typeof import('./native-http');
  jest.isolateModules(() => {
    mod = require('./native-http');
  });
  return mod;
}

const mockWebFetch = jest.fn();
let nativeHttp: typeof import('./native-http');

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(true);
  mockRpcUrl = 'https://rpc.test';
  mockProverUrl = 'https://prover.test';
  mockNoteTransportUrl = 'https://transport.test';
  mockWebFetch.mockResolvedValue('web answer');
  mockNativeRequest.mockResolvedValue({ status: 200, headers: {}, data: '{}' });
  globalThis.fetch = mockWebFetch;
  nativeHttp = loadNativeHttp();
  nativeHttp.installGuardianCorsBypass();
});

/** Which transport a GET to `url` took through the installed interceptor. */
async function transportFor(url: string): Promise<'native' | 'web'> {
  mockNativeRequest.mockClear();
  mockWebFetch.mockClear();
  await globalThis.fetch(url);
  if (mockNativeRequest.mock.calls.length === 1 && mockWebFetch.mock.calls.length === 0) return 'native';
  if (mockWebFetch.mock.calls.length === 1 && mockNativeRequest.mock.calls.length === 0) return 'web';
  throw new Error(`${url} took no single transport`);
}

describe('installGuardianCorsBypass', () => {
  it('leaves fetch untouched off mobile', () => {
    mockIsMobile.mockReturnValue(false);
    globalThis.fetch = mockWebFetch;
    const offMobile = loadNativeHttp();

    offMobile.installGuardianCorsBypass();

    expect(globalThis.fetch).toBe(mockWebFetch);
  });

  it.each([
    ['node RPC', 'https://rpc.test'],
    ['prover', 'https://prover.test'],
    ['note transport', 'https://transport.test'],
    ['page', globalThis.location.origin]
  ])('never sends the %s origin through native HTTP, even when registered as a Guardian', async (_name, origin) => {
    nativeHttp.registerGuardianOrigin(origin);

    expect(await transportFor(`${origin}/rpc.Api/SyncState`)).toBe('web');
  });

  it('honours an endpoint override saved after the origin was registered, from the next request', async () => {
    nativeHttp.registerGuardianOrigin(CUSTOM);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    mockRpcUrl = CUSTOM;

    expect(await transportFor(`${CUSTOM}/rpc.Api/SyncState`)).toBe('web');
  });

  it('keeps routing Guardians on a network with no prover or note transport configured', async () => {
    mockProverUrl = undefined;
    mockNoteTransportUrl = undefined;
    nativeHttp.registerGuardianOrigin(CUSTOM);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('treats a URL with a path, trailing slash, host capitals or default port as the RPC origin', async () => {
    mockRpcUrl = 'https://rpc.test/v1/';
    nativeHttp.registerGuardianOrigin('https://RPC.test:443/guardian/');

    expect(await transportFor('https://rpc.test/rpc.Api/SyncState')).toBe('web');
  });

  it('never routes the page origin, even once a probe of it settles as a Guardian', async () => {
    nativeHttp.probeGuardianOrigin(`${globalThis.location.origin}/`)(true);

    expect(await transportFor(`${globalThis.location.origin}/assets/app.wasm`)).toBe('web');
  });

  it('never routes a non-http origin such as capacitor://localhost, the iOS WebView page', async () => {
    nativeHttp.registerGuardianOrigin('capacitor://localhost');
    nativeHttp.probeGuardianOrigin('capacitor://localhost')(true);

    expect(await transportFor('capacitor://localhost/assets/app.wasm')).toBe('web');
  });
});

describe('probeGuardianOrigin', () => {
  it('routes a probed origin while the probe is in flight and releases it on false', async () => {
    const settle = nativeHttp.probeGuardianOrigin(`${CUSTOM}/`);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    settle(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('keeps a probed origin routed for the session once the probe settles true', async () => {
    nativeHttp.probeGuardianOrigin(CUSTOM)(true);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('keeps an origin routed until the last overlapping probe of it lets go', async () => {
    const pickerCheck = nativeHttp.probeGuardianOrigin(CUSTOM);
    const driftCheck = nativeHttp.probeGuardianOrigin(CUSTOM);

    pickerCheck(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
    driftCheck(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('keeps an origin routed when one overlapping probe proves it a Guardian and the other then fails', async () => {
    const pickerCheck = nativeHttp.probeGuardianOrigin(CUSTOM);
    const driftCheck = nativeHttp.probeGuardianOrigin(CUSTOM);

    pickerCheck(true);
    driftCheck(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('never removes a built-in origin when a probe of it fails', async () => {
    nativeHttp.probeGuardianOrigin(BUILTIN)(false);

    expect(await transportFor(`${BUILTIN}/pubkey`)).toBe('native');
  });

  it('never removes a registered origin when a probe of it fails', async () => {
    nativeHttp.registerGuardianOrigin(CUSTOM);

    nativeHttp.probeGuardianOrigin(CUSTOM)(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('ignores every settle after the first', async () => {
    const first = nativeHttp.probeGuardianOrigin(CUSTOM);
    const second = nativeHttp.probeGuardianOrigin(CUSTOM);

    first(false);
    first(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
    first(true);
    second(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('gives an unparseable endpoint a settle that does nothing, and never throws', () => {
    expect(() => nativeHttp.probeGuardianOrigin('https://')(true)).not.toThrow();
    expect(() => nativeHttp.registerGuardianOrigin('https://')).not.toThrow();
  });

  it('routes a probed origin again once an override that reserved it mid-probe is cleared', async () => {
    const settle = nativeHttp.probeGuardianOrigin(CUSTOM);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    mockRpcUrl = `${CUSTOM}/`;
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
    mockRpcUrl = 'https://rpc.test';
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    settle(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });
});
