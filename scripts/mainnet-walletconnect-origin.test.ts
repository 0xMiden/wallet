/** @jest-environment node */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const config = fs.readFileSync(resolve(__dirname, '../vite.extension.config.ts'), 'utf8');
const source = config.slice(
  config.indexOf('const DEFAULT_WALLETCONNECT_PROJECT_ID'),
  config.indexOf('// ── SW patches')
);
// Execute the real manifest writer without initializing Vite or compiling the wallet.
const writer = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const directory: string[] = [];
afterEach(() => directory.splice(0).forEach(path => fs.rmSync(path, { recursive: true, force: true })));
function manifest(overrides: Record<string, string> = {}): Record<string, unknown> {
  const root = fs.mkdtempSync(join(tmpdir(), 'mainnet-reown-origin-'));
  directory.push(root);
  fs.mkdirSync(join(root, 'public'));
  const outDir = join(root, 'out');
  fs.mkdirSync(outDir);
  fs.writeFileSync(join(root, 'public', 'manifest.json'), JSON.stringify({ version: '1.0.0', name: 'Bread' }));
  const env = {
    MIDEN_E2E_TEST: 'true',
    MIDEN_E2E_MAINNET_NIGHTLY: 'true',
    MIDEN_NETWORK: 'mainnet',
    WALLETCONNECT_PROJECT_ID: 'a'.repeat(32),
    ...overrides
  };
  runInNewContext(`${writer}\ncopyPublicAssets(outDir).closeBundle();`, {
    ...fs,
    join,
    resolve,
    __dirname: root,
    outDir,
    process: { env },
    pkg: { version: '1.0.0' },
    TARGET_BROWSER: 'chrome',
    MANIFEST_FILE: 'manifest.json',
    MIDEN_NETWORK: env.MIDEN_NETWORK
  });
  return JSON.parse(fs.readFileSync(join(outDir, 'manifest.json'), 'utf8'));
}
function extensionId(value: unknown): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') throw new Error('Missing stable E2E public key');
  return createHash('sha256')
    .update(Buffer.from(value, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(parseInt(digit, 16) + 97));
}
it('uses the existing approved Reown origin only for the scoped mainnet nightly E2E build', () => {
  expect(extensionId(manifest().key)).toBe('dfkbipcpggpmndndboecmjgjdgcncbhl');
});
it.each(['', ' ', 'd18d112eb50cbe764f03e51a90210611', 'not-a-project-id'])(
  'refuses a missing, default or malformed dedicated nightly project: %s',
  project => {
    expect(() => manifest({ WALLETCONNECT_PROJECT_ID: project })).toThrow('dedicated WALLETCONNECT_PROJECT_ID');
  }
);
it('keeps the stable origin absent from production even if the scoped flag leaked into its environment', () => {
  expect(manifest({ MIDEN_E2E_TEST: 'false' })).not.toHaveProperty('key');
});
it('keeps unrelated mainnet E2E builds unchanged', () => {
  expect(manifest({ MIDEN_E2E_MAINNET_NIGHTLY: 'false' })).not.toHaveProperty('key');
});
it('does not turn the mainnet nightly flag into a testnet rollout flag', () => {
  expect(manifest({ MIDEN_NETWORK: 'testnet' })).not.toHaveProperty('key');
});
it('preserves the existing OneClick dedicated project and stable origin', () => {
  const value = manifest({
    MIDEN_NETWORK: 'localhost',
    MIDEN_E2E_MAINNET_NIGHTLY: 'false',
    MIDEN_E2E_ONE_CLICK_TESTNET: 'true'
  });
  expect(extensionId(value.key)).toBe('dfkbipcpggpmndndboecmjgjdgcncbhl');
});
it('still refuses a missing dedicated project for the existing OneClick build', () => {
  expect(() =>
    manifest({ MIDEN_E2E_MAINNET_NIGHTLY: 'false', MIDEN_E2E_ONE_CLICK_TESTNET: 'true', WALLETCONNECT_PROJECT_ID: '' })
  ).toThrow('dedicated WALLETCONNECT_PROJECT_ID');
});
