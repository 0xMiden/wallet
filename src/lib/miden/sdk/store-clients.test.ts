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
const SRC = path.join(__dirname, '../../..');
const OWNER = 'lib/miden/sdk/miden-client-interface.ts';

// The constructors that open the store. The prove worker's bare `new WebClient()` opens none.
const STORE_CLIENT_CONSTRUCTOR =
  /\b(?:MidenClient\.create(?:Mock)?|WebClient\.createClient|createClientWithExternalKeystore)\(/;
const REACT_SDK_IMPORT = /(?:from|import\()\s*['"]@miden-sdk\/react(?:\/[^'"]*)?['"]/;

const SOURCES = fs
  .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__mocks__'));

const codeOf = (file: string) =>
  fs
    .readFileSync(path.join(SRC, file), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

describe('clients on the SDK store', () => {
  it('scans the source tree', () => {
    expect(SOURCES).toContain(OWNER);
  });

  it('only MidenClientInterface constructs a store client', () => {
    const builders = SOURCES.filter(file => STORE_CLIENT_CONSTRUCTOR.test(codeOf(file)));
    expect(builders).toEqual([OWNER]);
  });

  it('nothing imports the React SDK, whose provider builds and syncs a client of its own', () => {
    expect(SOURCES.filter(file => REACT_SDK_IMPORT.test(codeOf(file)))).toEqual([]);
  });
});
