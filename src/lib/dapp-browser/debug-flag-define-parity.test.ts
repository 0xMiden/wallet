import fs from 'fs';
import path from 'path';

/**
 * Every build-time flag the dApp-bridge modules read must be `define`d in every
 * Vite config that bundles them.
 *
 * A `process.env.X` read with no matching define does NOT fail loudly: the
 * bundler rewrites the un-matched `process.env` base to an empty object literal,
 * so the shipped code is `{}.X === '1'` — permanently `undefined`. That is how
 * `DEBUG_DAPP_BRIDGE` went dead in all five bundles while `dapp.ts` and
 * `message-handler.ts` still documented "Enable via `DEBUG_DAPP_BRIDGE=1` env at
 * build time": every `dappDebug(...)` / `dlog(...)` call was dead code, so an
 * engineer diagnosing a dApp connect/sign failure got no log line at all and
 * concluded the backend was never reached.
 *
 * The reads are discovered from the source rather than listed here, so a new
 * flag added to either module is covered the day it lands.
 */
const REPO_ROOT = path.join(__dirname, '../../..');

/** Modules bundled into all five targets — extension pages, SW, content scripts, mobile, desktop. */
const BRIDGE_MODULES = ['src/lib/miden/back/dapp.ts', 'src/lib/dapp-browser/message-handler.ts'];

const CONFIGS = [
  'vite.extension.config.ts',
  'vite.background.config.ts',
  'vite.contentScripts.config.ts',
  'vite.mobile.config.ts',
  'vite.desktop.config.ts'
];

const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

/** Flag names read as `process.env.X` / `process.env?.X` by the given source. */
function envReads(source: string): string[] {
  return [...source.matchAll(/process\.env\??\.([A-Z0-9_]+)/g)].map(match => match[1]!);
}

const flags = [...new Set(BRIDGE_MODULES.flatMap(module => envReads(read(module))))];

describe('dApp-bridge build-time flags', () => {
  it('reads at least one build-time flag (otherwise this suite guards nothing)', () => {
    expect(flags).toContain('DEBUG_DAPP_BRIDGE');
  });

  describe.each(CONFIGS)('%s', config => {
    const source = read(config);

    it.each(flags)('defines process.env.%s', flag => {
      expect(source).toContain(`'process.env.${flag}':`);
    });
  });
});
