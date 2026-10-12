const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const device = process.argv[2];
if (!device) throw new Error('Usage: node scripts/ios-test-screenshots.cjs <simulator ID>');
const lookupTimeoutMs = 1500;
const rediscoveryDelayMs = 250;

// Hosted XCTest cannot use XCUIScreen. Capture the composed simulator screen from the host instead.
let directory;
let busy = false;
let nextLookupAt = 0;
const handled = new Set();
const diagnosticKeys = new Map();
const started = Date.now();

function diagnostic(event, fields, key) {
  if (key && diagnosticKeys.get(event) === key) return;
  if (key) diagnosticKeys.set(event, key);
  console.log(JSON.stringify({ at: new Date().toISOString(), event, device, ...fields }));
}

function rediscover() {
  directory = undefined;
  nextLookupAt = Date.now() + rediscoveryDelayMs;
}

async function capture() {
  if (busy) return;
  if (!directory && Date.now() < nextLookupAt) return;
  busy = true;
  try {
    if (!directory) {
      const lookupStarted = Date.now();
      diagnostic('lookup-start', { timeoutMs: lookupTimeoutMs }, 'started');
      let stdout;
      try {
        ({ stdout } = await run('xcrun', ['simctl', 'get_app_container', device, 'com.miden.bread', 'data'], {
          timeout: lookupTimeoutMs,
          killSignal: 'SIGKILL'
        }));
      } catch (error) {
        diagnostic(
          'lookup-error',
          {
            durationMs: Date.now() - lookupStarted,
            error: error.message,
            code: error.code,
            signal: error.signal
          },
          `${error.code}:${error.signal}:${error.message}`
        );
        throw error;
      }
      directory = path.join(stdout.trim(), 'tmp', 'bread-rotation-regression');
      diagnostic('lookup-resolved', { directory, durationMs: Date.now() - lookupStarted }, directory);
    }
    const readStarted = Date.now();
    const request = JSON.parse(await fs.readFile(path.join(directory, 'request.json'), 'utf8'));
    if (typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.id)) {
      throw new Error('Invalid simulator screenshot request ID');
    }
    const requestKey = path.join(directory, request.id);
    const details = {
      id: request.id,
      directory,
      requestedAt: request.requestedAt,
      ageMs: Date.now() - request.requestedAt,
      readMs: Date.now() - readStarted,
      requestedDevice: request.device,
      reportedDirectory: request.directory,
      label: request.label,
      rotating: request.rotating
    };
    const skipped = request.requestedAt < started ? 'old-request' : handled.has(requestKey) ? 'handled-id' : null;
    if (skipped) {
      diagnostic(
        'request-skipped',
        { ...details, reason: skipped, helperStartedAt: started },
        `${requestKey}:${skipped}`
      );
      rediscover();
      return;
    }
    diagnostic('request', details);
    handled.add(requestKey);
    const captureStarted = Date.now();
    try {
      if (request.device !== device) throw new Error('Screenshot request targets a different simulator');
      const pending = path.join(directory, `${request.id}.capturing.png`);
      diagnostic('capture-start', { id: request.id, pending });
      await run('xcrun', ['simctl', 'io', device, 'screenshot', '--type=png', pending]);
      const nativeMs = Date.now() - captureStarted;
      diagnostic('capture-native-complete', { id: request.id, durationMs: nativeMs });
      await run('sips', ['-Z', '1800', pending]);
      await fs.rename(pending, path.join(directory, `${request.id}.png`));
      diagnostic('capture-complete', { id: request.id, directory, nativeMs, durationMs: Date.now() - captureStarted });
    } catch (error) {
      diagnostic('capture-error', {
        id: request.id,
        directory,
        durationMs: Date.now() - captureStarted,
        error: error.message
      });
      const pending = path.join(directory, `${request.id}.error.pending`);
      await fs.writeFile(pending, error.message);
      await fs.rename(pending, path.join(directory, `${request.id}.error`));
    }
  } catch (error) {
    if (error.cmd?.includes('get_app_container') !== true) {
      diagnostic(
        'request-error',
        { directory, error: error.message, code: error.code },
        `${directory}:${error.message}`
      );
    }
    rediscover();
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
