import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWalletBuildIdentity } from './crash-build-identity';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'wallet-build-identity-'));
  roots.push(root);
  for (const args of [
    ['init', '-q'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']
  ]) {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  }
  return root;
}

describe('source-bound wallet build identity', () => {
  it('reads the real revision and a clean state', () => {
    const root = repository();
    expect(readWalletBuildIdentity(root)).toEqual({
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: 'false'
    });
  });
  it('records an untracked source as dirty without returning its name or content', () => {
    const root = repository();
    writeFileSync(join(root, 'private.txt'), 'private value');
    expect(readWalletBuildIdentity(root).dirty).toBe('true');
    expect(JSON.stringify(readWalletBuildIdentity(root))).not.toContain('private');
  });
  it('fails closed outside a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'wallet-build-untracked-'));
    roots.push(root);
    expect(readWalletBuildIdentity(root)).toEqual({ revision: '', dirty: 'unknown' });
  });
});
