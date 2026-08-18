import fs from 'fs';
import path from 'path';

/**
 * The devnet build entry points must be runnable.
 *
 * The extension and desktop builds were migrated from webpack to Vite
 * (`vite.extension.config.ts`, `vite.desktop.config.ts`, …) but `build:devnet`
 * and `build:desktop:devnet` were left on the old pipeline: they called
 * `yarn clear:webpack-cache` (a script that does not exist) and `webpack`
 * (no config exists anywhere in the repo), so the documented devnet command —
 * `CLAUDE.md` and `AGENTS.md` both point at `yarn build:devnet` — wiped `dist/`
 * with its leading `rimraf` and then failed. `build-all` (`run-s build:*`)
 * expands to include `build:devnet`, so it failed for the same reason. Mobile
 * was fine because `build:mobile:devnet` had been migrated.
 *
 * These guards pin the migrated form: every script must reference only commands
 * that exist, and the devnet entries must wrap their Vite equivalents.
 */
const pkg: { scripts: Record<string, string> } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
);

const REPO_ROOT = path.join(__dirname, '../..');

describe('package.json build scripts', () => {
  it('has no script that shells out to webpack', () => {
    const offenders = Object.entries(pkg.scripts).filter(([, cmd]) => /(^|\s)webpack(\s|$)/.test(cmd));
    expect(offenders).toEqual([]);
  });

  it('ships no webpack config for such a script to use', () => {
    const configs = fs
      .readdirSync(REPO_ROOT)
      .filter(name => name.startsWith('webpack') && (name.endsWith('.js') || name.endsWith('.ts')));
    expect(configs).toEqual([]);
  });

  it('never invokes a `yarn <script>` that is not defined', () => {
    // Yarn's own built-in subcommands are not package scripts.
    const YARN_BUILTINS = new Set(['cache', 'install', 'add', 'remove', 'run', 'why', 'link', 'unlink', 'upgrade']);
    const defined = new Set(Object.keys(pkg.scripts));
    const missing: string[] = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const match of cmd.matchAll(/yarn ([a-z0-9:_-]+)/g)) {
        const referenced = match[1]!;
        if (YARN_BUILTINS.has(referenced)) continue;
        // Anything else that is not defined fails the `&&` chain at runtime —
        // which is exactly how `build:devnet` died on `yarn clear:webpack-cache`,
        // AFTER its leading `rimraf ./dist` had already deleted the build output.
        if (!defined.has(referenced)) missing.push(`${name} → yarn ${referenced}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('builds devnet through the Vite extension/desktop/mobile builds', () => {
    expect(pkg.scripts['build:devnet']).toBe('cross-env MIDEN_NETWORK=devnet yarn build:extension');
    expect(pkg.scripts['build:desktop:devnet']).toBe('cross-env MIDEN_NETWORK=devnet yarn build:desktop');
    // The pattern the migrated mobile script already followed.
    expect(pkg.scripts['build:mobile:devnet']).toBe('cross-env MIDEN_NETWORK=devnet yarn build:mobile');
  });
});
