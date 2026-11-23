/** @jest-environment node */
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { build } = require('esbuild');

// Compile the actual entry, keeping its unrelated dependencies external.
// The output dependency graph must not be able to load the test hook in production.
test.each([
  ['false', false],
  ['true', true]
])('offscreen entry includes the fault bootstrap only for E2E=%s', async (flag, includesBootstrap) => {
  const source = resolve(__dirname, '../src/offscreen/main.ts');
  const result = await build({
    stdin: { contents: readFileSync(source, 'utf8'), sourcefile: source, loader: 'ts' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['*'],
    write: false,
    metafile: true,
    define: { 'process.env.MIDEN_E2E_TEST': JSON.stringify(flag) }
  });
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
  expect(imports.some(dependency => dependency.path === './e2e-fetch-faults')).toBe(includesBootstrap);
});
