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
  validPreparedBinary
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
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('preparation constrains the released kernel before resolving and verifies a locked all-feature graph', () =>
  temporary(dir => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), manifest);
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), lock('0.17.0'));
    const commands = [];
    prepareSource(dir, pin, (command, args) => {
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
