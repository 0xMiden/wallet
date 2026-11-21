/** @jest-environment node */
import { execFileSync, spawnSync } from 'node:child_process';

it('checks native send and final Guardian consume bytes against the installed SDK', () => {
  execFileSync(
    'yarn',
    [
      'esbuild',
      'src/lib/miden/sdk/test-send-request.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--alias:@miden-sdk/miden-sdk/lazy=@miden-sdk/miden-sdk',
      '--external:@miden-sdk/miden-sdk',
      '--outfile=node_modules/.cache/nightly-send-request.mjs'
    ],
    { encoding: 'utf8' }
  );
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=2', 'scripts/mainnet-send-request.test.mjs', 'test/sdk018-auth.node.test.mjs'],
    {
      encoding: 'utf8',
      timeout: 60_000
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 60_000);
