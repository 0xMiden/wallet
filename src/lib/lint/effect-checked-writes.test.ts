/** @jest-environment node */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MESSAGE =
  'Value-moving writes go through midenClientProxy inside withEffectCheckedSigner (transaction/index.ts); add the file to the allowlist only with a signing-time effect check.';

const ROOT = path.resolve(__dirname, '../../..');
const ESLINT_BIN = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');

// ESLint runs in a child process: loading its plugins through Jest's module registry fails to resolve their JSON requires.
const lint = async (code: string, filePath: string) => {
  const run = spawnSync(
    process.execPath,
    [ESLINT_BIN, '--no-eslintrc', '-c', '.eslintrc', '--stdin', '--stdin-filename', filePath, '-f', 'json'],
    { cwd: ROOT, input: code, encoding: 'utf8' }
  );
  const [result] = JSON.parse(run.stdout);
  return result.messages
    .filter((m: { ruleId: string }) => m.ruleId === 'no-restricted-syntax')
    .map((m: { message: string }) => m.message);
};

const WRITE = 'client.transactions.executeRequest(id, req);\n';

// Pinned here so a new exemption is a reviewed test edit, not only a config line.
const ALLOWLIST = [
  'src/lib/miden/sdk/miden-client-interface.ts',
  'src/lib/miden/back/miden-client-proxy.ts',
  'src/offscreen/main.ts',
  'src/lib/miden/sdk/dry-run-request.ts',
  'src/lib/miden/sdk/custom-dry-run.ts',
  'src/lib/miden/transaction/index.ts'
];

// Each case starts ESLint with the full config, which takes seconds under a loaded coverage run.
jest.setTimeout(60_000);

describe('effect-checked write lint', () => {
  it('reports a raw write outside the allowlist', async () => {
    expect(await lint(WRITE, 'src/lib/miden/foo/bar.ts')).toEqual([MESSAGE]);
  });

  it.each(['newTransaction', 'executeTransaction', 'submitNewTransaction', 'submitProvenTransaction'])(
    'reports %s',
    async name => {
      expect(await lint(`client.${name}(a);\n`, 'src/lib/miden/foo/bar.ts')).toEqual([MESSAGE]);
    }
  );

  it('exempts only the allowlisted writers and test files from the write ban', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.eslintrc'), 'utf8'));
    const exemptions = config.overrides
      .filter((o: { rules?: Record<string, unknown> }) => o.rules && 'no-restricted-syntax' in o.rules)
      .map((o: { files: string[]; rules: Record<string, unknown> }) => [
        o.files,
        o.rules['no-restricted-syntax'] === 'off'
      ]);
    expect(exemptions).toEqual([
      [ALLOWLIST, false],
      [['**/*.test.ts', '**/*.test.tsx'], true]
    ]);
  });

  it('reports a raw write in fee-notes.ts, which may only read outputNotes', async () => {
    expect(await lint(WRITE, 'src/lib/miden/activity/fee-notes.ts')).toEqual([MESSAGE]);
  });

  it('bans outputNotes in fee-notes.ts outside its one sanctioned read', async () => {
    const messages = await lint('executed.outputNotes();\n', 'src/lib/miden/activity/fee-notes.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('splitExecutedOutputNotes');
  });

  it('reports a raw write in the custom-transaction simulator, which only dry-runs through custom-dry-run.ts', async () => {
    expect(await lint(WRITE, 'src/lib/miden/back/simulate-custom-tx.ts')).toEqual([MESSAGE]);
  });

  it('allows the write in an allowlisted file', async () => {
    expect(await lint(WRITE, 'src/lib/miden/sdk/dry-run-request.ts')).toEqual([]);
  });

  it('still bans outputNotes in an allowlisted file', async () => {
    const messages = await lint('executed.outputNotes();\n', 'src/lib/miden/sdk/dry-run-request.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('splitExecutedOutputNotes');
  });

  it('exempts test files', async () => {
    expect(await lint(WRITE, 'src/lib/miden/foo/bar.test.ts')).toEqual([]);
  });
});
