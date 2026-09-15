/**
 * Every module a vite config imports must be TRACKED BY GIT.
 *
 * This exists because an untracked-but-present source file is invisible to every
 * local signal: the build passes (the file is on disk), `git status` stays clean,
 * and `git add -A` skips it — so the break only appears in CI, as
 * `Could not resolve './src/lib/...' in vite.<target>.config.ts`, after the
 * checkout that does not have it.
 *
 * It happened: `src/lib/build/worker-wasm-assets.ts` was matched by the bare
 * `build/` rule in .gitignore — a rule under the "# Xcode" heading, there to
 * ignore nested Xcode/Gradle output directories, which also matches any source
 * directory called `build/`. The desktop and mobile configs both imported it, so
 * all three Compile-surfaces jobs (desktop, iOS, Android) failed while every local
 * build was green. The module now lives in `src/lib/build-assets/`.
 *
 * Tightening the .gitignore rule instead would risk committing real Xcode/Gradle
 * output, so the invariant is enforced here rather than by narrowing the pattern.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

const viteConfigs = fs.readdirSync(ROOT).filter(f => /^vite\..*\.config\.ts$/.test(f));

/** Relative specifiers (`./…` / `../…`) a config imports — the ones that resolve to repo files. */
function relativeImportsOf(configFile: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, configFile), 'utf8');
  return [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"](\.[^'"]+)['"]/g)].map(m => m[1]!);
}

function resolveToFile(fromConfig: string, spec: string): string | undefined {
  const base = path.resolve(ROOT, path.dirname(fromConfig), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    path.join(base, 'index.ts')
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function isTracked(absPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path.relative(ROOT, absPath)], {
      cwd: ROOT,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

describe('vite configs only import git-tracked modules', () => {
  it('finds the vite configs (guards against the glob silently matching nothing)', () => {
    expect(viteConfigs.length).toBeGreaterThanOrEqual(4);
  });

  it.each(viteConfigs)('%s imports only tracked files', configFile => {
    const untracked = relativeImportsOf(configFile)
      .map(spec => ({ spec, file: resolveToFile(configFile, spec) }))
      // A specifier that resolves to nothing is a different failure (the build
      // catches it locally); this test is about files that exist but are ignored.
      .filter(({ file }) => file !== undefined && !isTracked(file))
      .map(({ spec, file }) => `${spec} -> ${path.relative(ROOT, file!)}`);

    expect(untracked).toEqual([]);
  });
});
