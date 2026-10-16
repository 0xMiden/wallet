import fs from 'fs';
import path from 'path';

/**
 * Every client the wallet opens on the SDK's IndexedDB store is built by `MidenClientInterface` (#1493).
 *
 * The SDK serializes syncs across client instances but not note imports, so a second instance on the same store can
 * interleave its sync with an import of ours and leave a tracked block header whose MMR path is too short for the
 * checkpoint. Every later sync and import then fails, permanently. The React SDK's `MidenProvider` was such an
 * instance: it built its own client and ran a full sync on every page open, beside the one the wallet's own loop drives.
 */
const ROOT = path.join(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');
const OWNER = 'lib/miden/sdk/miden-client-interface.ts';

// Every factory family that opens a store: the static `MidenClient.create*` factories, `*WebClient.createClient*` on any
// client class (`WasmWebClient`, `MockWasmWebClient`) and a bare `createClientWithExternalKeystore`.
const STORE_CLIENT_CONSTRUCTOR =
  /\bMidenClient\.create\w*\(|\b\w*WebClient\.createClient\w*\(|\bcreateClientWithExternalKeystore\(/;
// A raw client, which opens a store through its instance `createClient`.
const RAW_CLIENT = /\bnew\s+\w*WebClient\(/;

const SOURCES = fs
  .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__mocks__'));

const codeOf = (file: string) =>
  fs
    .readFileSync(path.join(SRC, file), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const matchesIn = (pattern: RegExp, code: string) => code.match(new RegExp(pattern.source, 'g')) ?? [];

const sitesOf = (pattern: RegExp) =>
  Object.fromEntries(
    SOURCES.map(file => [file, matchesIn(pattern, codeOf(file)).sort()] as const).filter(([, found]) => found.length)
  );

describe('clients on the SDK store', () => {
  it.each([
    'MidenClient.create(',
    'MidenClient.createTestnet(',
    'MidenClient.createDevnet(',
    'MidenClient.createMock(',
    'WasmWebClient.createClient(',
    'MockWasmWebClient.createClient(',
    'WasmWebClient.createClientWithExternalKeystore(',
    'createClientWithExternalKeystore('
  ])('recognises %s', call => {
    expect(STORE_CLIENT_CONSTRUCTOR.test(call)).toBe(true);
  });

  it('leaves a createClient that is not the SDK alone', () => {
    expect(STORE_CLIENT_CONSTRUCTOR.test('context.createClient(account, operator)')).toBe(false);
  });

  it.each(['new WebClient()', 'new WasmWebClient()'])('recognises the raw client %s', call => {
    expect(RAW_CLIENT.test(call)).toBe(true);
  });

  it('only miden-client-interface.ts constructs store clients, at its three known sites', () => {
    expect(sitesOf(STORE_CLIENT_CONSTRUCTOR)).toEqual({
      [OWNER]: ['MidenClient.create(', 'MidenClient.createMock(', 'WasmWebClient.createClient(']
    });
  });

  it("builds no raw client but the prove worker's store-less one", () => {
    expect(sitesOf(RAW_CLIENT)).toEqual({ 'offscreen/prove-worker.ts': ['new WebClient('] });
  });

  it('does not depend on the React SDK, whose provider builds and syncs a client of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(manifest.dependencies).not.toHaveProperty(['@miden-sdk/react']);
    expect(manifest.devDependencies ?? {}).not.toHaveProperty(['@miden-sdk/react']);
  });
});
