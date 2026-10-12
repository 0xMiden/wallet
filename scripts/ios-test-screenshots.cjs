const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const device = process.argv[2];
if (!device) throw new Error('Usage: node scripts/ios-test-screenshots.cjs <simulator ID>');

// Hosted XCTest cannot use XCUIScreen. Capture the composed simulator screen from the host instead.
let directory;
let busy = false;
const handled = new Set();
const started = Date.now();

async function capture() {
  if (busy) return;
  busy = true;
  try {
    if (!directory) {
      const { stdout } = await run('xcrun', ['simctl', 'get_app_container', device, 'com.miden.bread', 'data']);
      directory = path.join(stdout.trim(), 'tmp', 'bread-rotation-regression');
    }
    const request = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8'));
    if (typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.id)) {
      throw new Error('Invalid simulator screenshot request ID');
    }
    if (request.requestedAt < started) return;
    if (handled.has(request.id)) return;
    handled.add(request.id);
    try {
      if (request.device !== device) throw new Error('Screenshot request targets a different simulator');
      const pending = path.join(directory, `${request.id}.capturing.png`);
      await run('xcrun', ['simctl', 'io', device, 'screenshot', '--type=png', pending]);
      await run('sips', ['-Z', '1800', pending]);
      await fs.rename(pending, path.join(directory, `${request.id}.png`));
    } catch (error) {
      const pending = path.join(directory, `${request.id}.error.pending`);
      await fs.writeFile(pending, error.message);
      await fs.rename(pending, path.join(directory, `${request.id}.error`));
    }
  } catch (error) {
    if (error.code === 'ENOENT') directory = undefined;
    if (error.code !== 'ENOENT' && error.cmd?.includes('get_app_container') !== true) {
      console.error(error.message);
    }
  } finally {
    busy = false;
  }
}

const timer = setInterval(capture, 50);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
