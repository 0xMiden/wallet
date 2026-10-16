import fs from 'fs';
import path from 'path';

/**
 * Where the wallet builds clients on the SDK's IndexedDB store (#1493). `miden-client-interface.ts` builds each realm's
 * client and its realm reader (`getRealmReaderClient`), which only reads, apart from the genesis header its first build
 * may store; no other wallet source builds one, and the wallet does not depend on the React SDK, whose `MidenProvider`
 * built a client of its own and synced it on every page open.
 *
 * A sync on one client interleaved with a note import on another can leave a tracked block header whose MMR path is
 * too short for the checkpoint, and every later sync and import then fails. This scan sees constructors written in
 * wallet source only, not a client that a dependency builds.
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
