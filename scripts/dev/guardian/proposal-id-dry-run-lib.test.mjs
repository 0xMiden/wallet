import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptFile = fileURLToPath(new URL('./proposal-id-dry-run.mjs', import.meta.url));
const helperFile = fileURLToPath(new URL('./proposal-id-dry-run-lib.mjs', import.meta.url));
const helperAvailable = existsSync(helperFile);
let installWordFreeShim;
let solveFaucetPow;

if (helperAvailable) {
  ({ installWordFreeShim, solveFaucetPow } = await import(pathToFileURL(helperFile).href));
} else {
  const source = readFileSync(scriptFile, 'utf8');
  const shim = source.match(/for \(const value of Object\.values\(sdkModule\)\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(shim, 'the current Word free shim is present in the dry-run script');
  installWordFreeShim = sdkModule => new Function('sdkModule', shim)(sdkModule);
}

test('installs the Node free shim on Word only', () => {
  class Word {}
  class Account {}
  class ExistingFree {}
  class Sealed {}
  const existingFree = () => 'existing';
  ExistingFree.prototype.free = existingFree;
  Object.preventExtensions(Sealed.prototype);

  installWordFreeShim({ Word, Account, ExistingFree, Sealed, value: {} });

  assert.equal(typeof Word.prototype.free, 'function');
  assert.equal(Word.prototype.free.call(new Word()), undefined);
  assert.equal(Account.prototype.free, undefined);
  assert.equal(ExistingFree.prototype.free, existingFree);
  assert.equal(Sealed.prototype.free, undefined);
});

const zeroTargetChild = String.raw`
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [scriptFile, helperFile] = process.argv.slice(1);
if (existsSync(helperFile)) {
  const { solveFaucetPow } = await import(pathToFileURL(helperFile).href);
  try {
    await solveFaucetPow('00', 0n, { deadlineMs: 50, hashesPerBatch: 1 });
    console.error('the unsatisfiable target unexpectedly resolved');
    process.exitCode = 1;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes('unsolved within 50ms') && message.includes('target=0')) console.log(message);
    else {
      console.error('the solver rejected with an unexpected error');
      process.exitCode = 1;
    }
  }
} else {
  const source = await readFile(scriptFile, 'utf8');
  const match = source.match(/const solvePow = \(([^)]*)\) => \{([\s\S]*?)^\};/m);
  if (!match) {
    console.error('the current PoW solver is absent from the dry-run script');
    process.exitCode = 2;
  } else {
    const solvePow = new Function('createHash', 'return (' + match[1] + ') => {' + match[2] + '\n};')(
      createHash
    );
    solvePow('00', 0n);
  }
}
`;

test('target 0 settles before the child deadline', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', zeroTargetChild, scriptFile, helperFile], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  let killed = false;
  const deadline = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, 1_000);

  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(killed, false, 'the child was killed instead of reporting the unsolved target');
    assert.equal(code, 0, `child exited with ${code ?? signal}: ${Buffer.concat(stderr).toString()}`);
    assert.match(Buffer.concat(stdout).toString(), /unsolved within 50ms.*target=0/);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

if (helperAvailable) {
  test('a nonpositive PoW deadline hashes nothing', async () => {
    let hashes = 0;
    await assert.rejects(
      solveFaucetPow('00', 1n, {
        deadlineMs: 0,
        hashesPerBatch: 1,
        hash: () => {
          hashes++;
          return 0n;
        }
      }),
      /unsolved within 0ms.*target=1/
    );
    assert.equal(hashes, 0);
  });

  test('the first nonce resolves when its digest is below the maximum target', async () => {
    let hashes = 0;
    await assert.doesNotReject(
      solveFaucetPow('00', 2n ** 64n, {
        deadlineMs: 1_000,
        hashesPerBatch: 1,
        hash: () => {
          hashes++;
          return 0n;
        }
      })
    );
    assert.equal(hashes, 1);
  });
}
