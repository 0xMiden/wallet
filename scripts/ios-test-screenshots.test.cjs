const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const helper = path.join(__dirname, 'ios-test-screenshots.cjs');
const device = '00000000-0000-4000-8000-000000000001';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-screenshot-helper-'));
  const cliPath = path.join(root, 'cli.cjs');
  const preload = path.join(root, 'preload.cjs');
  const state = path.join(root, 'state.json');
  const calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(state, JSON.stringify({ container: path.join(root, 'container-a'), ...options }));
  const cli = `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [command, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.HELPER_TEST_STATE, 'utf8'));
const call = { command, args, at: Date.now() };
fs.appendFileSync(process.env.HELPER_TEST_CALLS, JSON.stringify(call) + '\\n');
if (command === 'xcrun' && args[1] === 'get_app_container') {
  assert.deepEqual(args, ['simctl', 'get_app_container', process.env.HELPER_TEST_DEVICE, 'com.miden.bread', 'data']);
  if (state.stallFirst && !fs.existsSync(process.env.HELPER_TEST_STATE + '.stalled')) {
    fs.writeFileSync(process.env.HELPER_TEST_STATE + '.stalled', 'yes');
    process.on('SIGTERM', () => {});
    setTimeout(() => {}, 30000);
  } else process.stdout.write(state.container + '\\n');
} else if (command === 'xcrun') {
  assert.deepEqual(args.slice(0, 5), ['simctl', 'io', process.env.HELPER_TEST_DEVICE, 'screenshot', '--type=png']);
  fs.writeFileSync(args[5], Buffer.from(process.env.HELPER_TEST_PNG, 'base64'));
} else {
  assert.deepEqual(args.slice(0, 2), ['-Z', '1800']);
  assert.ok(fs.readFileSync(args[2]).equals(Buffer.from(process.env.HELPER_TEST_PNG, 'base64')));
}
`;
  await fs.writeFile(cliPath, cli);
  // Fake commands remain child processes without temporary executable-script startup delays.
  await fs.writeFile(
    preload,
    `
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const original = childProcess.execFile;
const run = promisify(original);
function route(file, args) {
  return ['xcrun', 'sips'].includes(file)
    ? [process.execPath, [process.env.HELPER_TEST_CLI, file, ...args]] : [file, args];
}
function fakeCli(file, args, ...rest) { return original(...route(file, args), ...rest); }
fakeCli[promisify.custom] = (file, args, ...rest) => run(...route(file, args), ...rest);
childProcess.execFile = fakeCli;
`
  );
  let child;
  let output = '';
  let errors = '';
  t.after(async () => {
    if (child) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      assert.ok(
        await until(() => child.exitCode !== null || child.signalCode !== null, 1000),
        'helper cleanup finished'
      );
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async start() {
      child = spawn(process.execPath, ['--require', preload, helper, device], {
        detached: true,
        env: {
          ...process.env,
          HELPER_TEST_CLI: cliPath,
          HELPER_TEST_STATE: state,
          HELPER_TEST_CALLS: calls,
          HELPER_TEST_DEVICE: device,
          HELPER_TEST_PNG: png.toString('base64')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', chunk => {
        output += chunk;
      });
      child.stderr.on('data', chunk => {
        errors += chunk;
      });
      assert.ok(
        await until(async () => (await this.calls()).length > 0, 5000),
        `helper started its lookup: ${errors}${output}`
      );
    },
    async state(next) {
      const pending = state + '.pending';
      await fs.writeFile(pending, JSON.stringify(next));
      await fs.rename(pending, state);
    },
    async request(container, fields = {}) {
      const directory = path.join(container, 'tmp', 'bread-rotation-regression');
      await fs.mkdir(directory, { recursive: true });
      const request = { id: randomUUID(), device, requestedAt: Date.now(), ...fields };
      const pending = path.join(directory, 'request.pending');
      await fs.writeFile(pending, JSON.stringify(request));
      await fs.rename(pending, path.join(directory, 'request.json'));
      return {
        ...request,
        directory,
        png: path.join(directory, request.id + '.png'),
        error: path.join(directory, request.id + '.error')
      };
    },
    async calls() {
      const content = await fs.readFile(calls, 'utf8').catch(() => '');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    output: () => output,
    errors: () => errors
  };
}

test('a stalled initial lookup recovers and publishes the native PNG within the 3-second request deadline', async t => {
  const f = await fixture(t, { stallFirst: true });
  await f.start();
  const container = path.join(f.root, 'container-a');
  const request = await f.request(container, {
    directory: 'reported-test-directory',
    label: 'rotation',
    rotating: true
  });
  const started = Date.now();

  assert.ok(await until(() => exists(request.png)), 'fresh request must complete within 3 seconds');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(await fs.readFile(request.png), png);
  assert.equal(await exists(request.error), false);
  assert.ok(
    await until(() =>
      f
        .output()
        .split('\n')
        .slice(0, -1)
        .some(line => {
          const entry = JSON.parse(line);
          return entry.event === 'capture-complete' && entry.id === request.id;
        })
    ),
    'this request has a capture-complete diagnostic'
  );
  const calls = await f.calls();
  assert.ok(calls.filter(call => call.args[1] === 'get_app_container').length >= 2);
  const pending = path.join(request.directory, `${request.id}.capturing.png`);
  const screenshotIndex = calls.findIndex(call => call.command === 'xcrun' && call.args[5] === pending);
  const resizeIndex = calls.findIndex(call => call.command === 'sips' && call.args[2] === pending);
  assert.ok(screenshotIndex >= 0);
  assert.deepEqual(calls[screenshotIndex].args, ['simctl', 'io', device, 'screenshot', '--type=png', pending]);
  assert.ok(resizeIndex > screenshotIndex);
  assert.deepEqual(calls[resizeIndex].args, ['-Z', '1800', pending]);
  assert.match(f.output(), /"event":"lookup-error"/);
  assert.match(f.output(), /"reportedDirectory":"reported-test-directory"/);
  assert.equal(f.errors(), '');
});

test('an old request does not pin discovery to a stale app container', async t => {
  const f = await fixture(t);
  const staleContainer = path.join(f.root, 'container-a');
  await f.request(staleContainer, { requestedAt: 1 });
  await f.start();
  assert.ok(await until(() => f.output().includes('old-request')));
  const container = path.join(f.root, 'container-b');
  const request = await f.request(container);
  await f.state({ container });

  assert.ok(await until(() => exists(request.png)), 'fresh mapping must be rediscovered');
  assert.deepEqual(await fs.readFile(request.png), png);
  assert.equal(await exists(request.error), false);
});

test('a handled request ID can be captured after its app container changes', async t => {
  const f = await fixture(t);
  await f.start();
  const first = await f.request(path.join(f.root, 'container-a'));
  assert.ok(await until(() => exists(first.png)));
  assert.ok(await until(() => f.output().includes('handled-id')));
  const container = path.join(f.root, 'container-b');
  const next = await f.request(container, { id: first.id });
  await f.state({ container });

  assert.ok(await until(() => exists(next.png)), 'handled IDs must be scoped to their container');
  assert.deepEqual(await fs.readFile(next.png), png);
  const captures = (await f.calls()).filter(call => call.args[3] === 'screenshot');
  assert.equal(captures.length, 2);
});

test('a request for another simulator publishes an error without invoking screenshot capture', async t => {
  const f = await fixture(t);
  await f.start();
  const request = await f.request(path.join(f.root, 'container-a'), { device: randomUUID() });

  assert.ok(await until(() => exists(request.error)));
  assert.match(await fs.readFile(request.error, 'utf8'), /targets a different simulator/);
  assert.equal(await exists(request.png), false);
  assert.equal((await f.calls()).filter(call => call.args[3] === 'screenshot').length, 0);
  assert.match(f.output(), /"event":"capture-error"/);
});
