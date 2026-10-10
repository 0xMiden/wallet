const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  constrainManifest,
  assertGraph,
  fingerprint,
  prepareSource,
  validPreparedBinary,
  runCommand,
  removeTemporarySource,
  withSourceCleanup,
  recordCacheSafety
} = require('./install-pinned-miden-cli.cjs');

const pin = {
  midenClientCliGit: { url: 'https://github.com/0xMiden/rust-sdk', rev: '0ae55272ffe67e9240285b1e820029f3da6ec51a' },
  midenClientCliVersion: '0.17.1',
  midenClientCliProtocolVersion: '0.17.1'
};
const manifest =
  '[workspace.dependencies]\n' +
  ['miden-protocol', 'miden-standards', 'miden-tx']
    .map(name => `${name} = { default-features = false, version = "0.17" }`)
    .join('\n');
const entry = (name, version) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
const lock = kernel =>
  ['miden-client', 'miden-client-cli', 'miden-client-proto', 'miden-client-sqlite-store']
    .map(name => entry(name, '0.17.1'))
    .join('') +
  ['miden-protocol', 'miden-standards', 'miden-tx', 'miden-agglayer', 'miden-protocol-build-utils']
    .map(name => entry(name, kernel))
    .join('') +
  entry('miden-assembly', '0.35.0') +
  entry('miden-processor', '0.35.0');

function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-prepare-test-'));
  try {
    return Promise.resolve(fn(dir)).finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('preparation constrains the released kernel before resolving and verifies a locked all-feature graph', () =>
  temporary(async dir => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), manifest);
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), lock('0.17.0'));
    const commands = [];
    await prepareSource(dir, pin, (command, args) => {
      commands.push([command, args]);
      if (args[0] === 'update') {
        assert.equal(fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8').match(/version = "=0.17.1"/g).length, 3);
        fs.writeFileSync(path.join(dir, 'Cargo.lock'), lock('0.17.1'));
      }
    });
    assert.deepEqual(commands, [
      ['cargo', ['update', '--workspace']],
      ['cargo', ['metadata', '--locked', '--all-features', '--format-version', '1']]
    ]);
  }));

test('rejects 0.17.2 or duplicate client/kernel resolutions', () => {
  assert.throws(() => assertGraph(lock('0.17.2'), '0.17.1', '0.17.1', lock('0.17.0')), /miden-protocol/);
  assert.throws(
    () => assertGraph(lock('0.17.1') + entry('miden-standards', '0.17.2'), '0.17.1', '0.17.1', lock('0.17.0')),
    /miden-standards/
  );
  assert.throws(
    () =>
      assertGraph(
        lock('0.17.1').replace(
          'name = "miden-client"\nversion = "0.17.1"',
          'name = "miden-client"\nversion = "0.17.2"'
        ),
        '0.17.1',
        '0.17.1',
        lock('0.17.0')
      ),
    /miden-client/
  );
});

test('rejects a newer transitive kernel support crate', () => {
  for (const name of ['miden-agglayer', 'miden-protocol-build-utils']) {
    assert.throws(
      () =>
        assertGraph(
          lock('0.17.1').replace(`name = "${name}"\nversion = "0.17.1"`, `name = "${name}"\nversion = "0.17.2"`),
          '0.17.1',
          '0.17.1',
          lock('0.17.0')
        ),
      new RegExp(name)
    );
  }
});

test('rejects VM version drift and incomplete manifest preparation', () => {
  assert.throws(
    () => assertGraph(lock('0.17.1').replaceAll('0.35.0', '0.35.1'), '0.17.1', '0.17.1', lock('0.17.0')),
    /VM graph/
  );
  assert.throws(() => constrainManifest('miden-protocol = { version = "0.17" }', '0.17.1'), /miden-standards/);
});

test('same-version binaries require matching source/kernel provenance and binary hash', () =>
  temporary(root => {
    fs.mkdirSync(path.join(root, 'bin'));
    const binary = path.join(root, 'bin', 'miden-client');
    fs.writeFileSync(binary, 'miden-client 0.17.1');
    assert.equal(validPreparedBinary(pin, root), false);
    const binaryHash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    fs.writeFileSync(path.join(root, 'prepared-cli.json'), JSON.stringify({ identity: fingerprint(pin), binaryHash }));
    assert.equal(validPreparedBinary(pin, root), true);
    assert.equal(validPreparedBinary({ ...pin, midenClientCliProtocolVersion: '0.17.2' }, root), false);
    assert.equal(
      validPreparedBinary({ ...pin, midenClientCliGit: { ...pin.midenClientCliGit, rev: 'a'.repeat(40) } }, root),
      false
    );
    fs.writeFileSync(binary, 'miden-client 0.17.1 with a different kernel');
    assert.equal(validPreparedBinary(pin, root), false);
  }));

test('timed-out commands stop their entire process group before returning on Unix', {
  skip: process.platform === 'win32'
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-process-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const childPidPath = path.join(dir, 'child.pid');
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.env.CHILD_PID_PATH, String(child.pid));",
    'setInterval(() => {}, 1000);'
  ].join('\n');

  await assert.rejects(
    runCommand(process.execPath, ['-e', source], {
      env: { ...process.env, CHILD_PID_PATH: childPidPath },
      stdio: 'ignore',
      timeoutMs: 750
    }),
    error => error.message.includes('Timed out after 750 ms') && error.processTreeStopped === true
  );

  const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
});

test('nonzero child exits retain their command and exit status', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(17)'], { stdio: 'ignore', timeoutMs: 5_000 }),
    /Command exited with code 17/
  );
});

test('source cleanup requests bounded retries for transient filesystem errors', async () => {
  let removedPath;
  let removeOptions;
  await removeTemporarySource('/tmp/miden-cli-source-test', async (source, options) => {
    removedPath = source;
    removeOptions = options;
  });
  assert.equal(removedPath, '/tmp/miden-cli-source-test');
  assert.deepEqual(removeOptions, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 250
  });
});

test('cleanup failure does not replace the original build error', async () => {
  const buildError = new Error('cargo install timed out');
  const cleanupError = Object.assign(new Error('directory is not empty'), { code: 'ENOTEMPTY' });
  const warnings = [];
  const originalError = console.error;
  console.error = message => warnings.push(message);
  try {
    await assert.rejects(
      withSourceCleanup('/tmp/miden-cli-source-test', async () => {
        throw buildError;
      }, async () => {
        throw cleanupError;
      }),
      error => error === buildError
    );
  } finally {
    console.error = originalError;
  }
  assert.match(warnings.join('\n'), /ENOTEMPTY/);
});

test('source is retained when the build process tree could not be stopped', async () => {
  const buildError = Object.assign(new Error('cargo install timed out'), { processTreeStopped: false });
  const warnings = [];
  let cleanupCalled = false;
  const originalError = console.error;
  console.error = message => warnings.push(message);
  try {
    await assert.rejects(
      withSourceCleanup('/tmp/miden-cli-source-test', async () => {
        throw buildError;
      }, async () => {
        cleanupCalled = true;
      }),
      error => error === buildError
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(cleanupCalled, false);
  assert.match(warnings.join('\n'), /could not be stopped/);
});

test('cache safety is recorded only for a successful build or a confirmed stopped process tree', () =>
  temporary(dir => {
    const output = path.join(dir, 'github-output');
    recordCacheSafety(output, true);
    recordCacheSafety(output, false);
    assert.equal(fs.readFileSync(output, 'utf8'), 'safe-to-cache=true\nsafe-to-cache=false\n');
  }));
