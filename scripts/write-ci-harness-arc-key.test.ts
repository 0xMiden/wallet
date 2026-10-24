/**
 * The step that hands E2E USDCx its Arc key. A key the runner would refuse, or none, must fail the job before anything
 * is built or spent, and nothing it prints may carry the key.
 *
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { harnessArcKey } from './e2e-real.mjs';
import { writeCiHarnessArcKey } from './write-ci-harness-arc-key.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');
const NOT_SET = 'USDCX_HARNESS_ARC_KEY is not set: store the CI harness Arc key as that repository secret';
const NOT_HEX = 'USDCX_HARNESS_ARC_KEY is not 0x and 64 lowercase hex';
const NOT_A_KEY = 'USDCX_HARNESS_ARC_KEY is not a valid secp256k1 private key';

const freshHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'ci-harness-key-'));
const keyFileIn = (home: string): string => path.join(home, '.miden-e2e', 'arc-keys', 'harness.json');
const modeOf = (file: string): number => statSync(file).mode & 0o777;

describe('writeCiHarnessArcKey', () => {
  it('writes the secret as the harness key the runner reads, 0600 in 0700 directories', async () => {
    const home = freshHome();
    const file = keyFileIn(home);
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);
    await expect(writeCiHarnessArcKey(file, key)).resolves.toEqual({ address });
    expect([modeOf(file), modeOf(path.dirname(file)), modeOf(path.join(home, '.miden-e2e'))]).toEqual([
      0o600, 0o700, 0o700
    ]);
    await expect(harnessArcKey(file, { create: false })).resolves.toEqual({ address, privateKey: key, created: false });
  });

  it('takes a secret stored with a trailing newline', async () => {
    const file = keyFileIn(freshHome());
    const key = generatePrivateKey();
    await expect(writeCiHarnessArcKey(file, `${key}\n`)).resolves.toEqual({
      address: privateKeyToAccount(key).address
    });
    await expect(harnessArcKey(file, { create: false })).resolves.toMatchObject({ privateKey: key });
  });

  it.each<[string, string | undefined, string]>([
    ['unset', undefined, NOT_SET],
    ['empty', '', NOT_SET],
    ['blank', ' \n', NOT_SET],
    ['without 0x', 'ab'.repeat(32), NOT_HEX],
    ['in upper case', `0x${'AB'.repeat(32)}`, NOT_HEX],
    ['a byte short', `0x${'ab'.repeat(31)}`, NOT_HEX],
    ['zero', `0x${'0'.repeat(64)}`, NOT_A_KEY],
    ['past the curve order', `0x${'f'.repeat(64)}`, NOT_A_KEY]
  ])('refuses a secret that is %s, writing nothing', async (_, secret, message) => {
    const home = freshHome();
    await expect(writeCiHarnessArcKey(keyFileIn(home), secret)).resolves.toEqual({ error: message });
    expect(existsSync(path.join(home, '.miden-e2e'))).toBe(false);
  });

  it('never replaces a key file that is already there', async () => {
    const file = keyFileIn(freshHome());
    await writeCiHarnessArcKey(file, generatePrivateKey());
    const written = readFileSync(file, 'utf8');
    await expect(writeCiHarnessArcKey(file, generatePrivateKey())).resolves.toEqual({
      error: `${file} already exists; it may hold USDC, so it is never replaced`
    });
    expect(readFileSync(file, 'utf8')).toBe(written);
  });
});

describe('the script, as the workflow step runs it', () => {
  const run = (home: string, secret?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.USDCX_HARNESS_ARC_KEY;
    if (secret !== undefined) env.USDCX_HARNESS_ARC_KEY = secret;
    return spawnSync(process.execPath, ['scripts/write-ci-harness-arc-key.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 30_000
    });
  };

  it('prints the address and the file, never the key', () => {
    const home = freshHome();
    const key = generatePrivateKey();
    const res = run(home, key);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`CI harness Arc key ${privateKeyToAccount(key).address} written to ${keyFileIn(home)}\n`);
    expect(res.stderr).not.toContain(key.slice(2));
    expect(modeOf(keyFileIn(home))).toBe(0o600);
  });

  it('fails the step with an annotation when the secret is not set, writing nothing', () => {
    const home = freshHome();
    const res = run(home);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe(`::error title=CI harness Arc key::${NOT_SET}\n`);
    expect(existsSync(path.join(home, '.miden-e2e'))).toBe(false);
  });
});
