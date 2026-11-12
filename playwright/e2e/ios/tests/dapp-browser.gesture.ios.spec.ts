import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import sharp from 'sharp';

import english from '../../../../public/_locales/en/en.json';
import { DappBrowserDriver } from '../../harness/dapp-browser-driver';
import { fixtureDapp, startDappFixtureServer } from '../../harness/dapp-fixture-server';
import { expect, test } from '../fixtures/two-simulators';
import { SimulatorControl } from '../helpers/simulator-control';

interface Point {
  x: number;
  y: number;
}
interface NativeReply {
  phase: string;
  pid: number;
  width: number;
  height: number;
  fbIdbVersion: string;
  capsule?: { x: number; y: number; width: number; height: number };
  afterFirstDownMs?: number;
  beforeUpMs?: number;
  downSamples?: number;
  upSamples?: number;
}

const active = new Set<ChildProcess>();
const helper = resolve(__dirname, '../helpers/idb_hid_path.py');

function idb(udid: string, bundle: string, op: string, request: object, phase?: (reply: NativeReply) => void) {
  const child = spawn('python3', [helper, '--udid', udid, '--bundle', bundle, '--op', op], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  active.add(child);
  return new Promise<NativeReply>((resolveResult, reject) => {
    let buffered = '';
    let stderr = '';
    let result: NativeReply | undefined;
    let protocolError: Error | undefined;
    const kill = setTimeout(() => child.kill('SIGTERM'), 40_000);
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 44_000);
    child.stdout.on('data', chunk => {
      buffered += String(chunk);
      if (buffered.length > 16_384) {
        protocolError = new Error('Native HID reply exceeded its bound');
        child.kill('SIGTERM');
        return;
      }
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const reply: NativeReply = JSON.parse(line);
          if (!['started', 'releasing', 'done'].includes(reply.phase)) throw new Error('Unknown native HID reply');
          phase?.(reply);
          if (reply.phase === 'done') result = reply;
        } catch {
          protocolError = new Error('Native HID reply is malformed');
          child.kill('SIGTERM');
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    child.stdin.on('error', error => {
      protocolError = error;
    });
    child.on('error', reject);
    child.on('close', code => {
      active.delete(child);
      clearTimeout(kill);
      clearTimeout(hardKill);
      if (protocolError) reject(protocolError);
      else if (code !== 0 || !result) reject(new Error(`Native HID failed (${code}): ${stderr}`));
      else resolveResult(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function footprint(file: string) {
  const { data, info } = await sharp(await readFile(file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = fixtureDapp('alpha').rgb;
  let count = 0;
  let top = info.height;
  let bottom = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (rgb.every((value, channel) => Math.abs(data[offset + channel]! - value) < 16)) {
        count += 1;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  expect(count, 'the real composited fixture must be visible').toBeGreaterThan(100);
  return { count, top, bottom, width: info.width, height: info.height };
}

test.describe('iOS native capsule gestures', () => {
  test.skip(process.env.DAPP_PRESENTATION_GESTURE_IOS !== '1', 'Requires the dedicated native idb input lane');

  test.afterEach(async () => {
    await Promise.all(
      [...active].map(
        child =>
          new Promise<void>(done => {
            const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
            child.once('close', () => {
              clearTimeout(timeout);
              done();
            });
            child.kill('SIGTERM');
          })
      )
    );
  });

  test('native capsule tracks, reverses and commits on the same document', async ({ walletA }, testInfo) => {
    await walletA.createGuardianWallet();
    const notification = await walletA.settleNotificationPrompt();
    expect(notification.answered, 'system permission UI must be gone before native input').toBe(true);
    const prefersReducedMotion = await walletA.evalJs<boolean>(
      'return window.matchMedia("(prefers-reduced-motion: reduce)").matches;'
    );
    expect(prefersReducedMotion, 'this lane requires observable native shrink, not a no-motion substitute').toBe(false);
    const fixture = await startDappFixtureServer({ deviceHost: '127.0.0.1', fullscreen: true });
    const sim = new SimulatorControl();
    const driver = new DappBrowserDriver({
      target: walletA,
      server: fixture,
      artifactDir: testInfo.outputDir,
      label: 'ios-gesture'
    });
    try {
      await driver.gotoBrowserTab();
      await driver.openViaUrlBar('alpha');
      await driver.expectDappPainted('alpha', 'native-capsule-ready');
      const initialSession = await driver.foregroundSession();
      if (!initialSession) throw new Error('Missing real fullscreen fixture session');
      const initial = await idb(walletA.udid, walletA.bundleId, 'bounds', { label: english.breadPresentationBack });
      const cases = [];
      for (const name of ['reversal', 'short-release', 'commit']) {
        await driver.waitForForeground('alpha');
        await driver.waitForMotionIdle();
        const bounds = await idb(walletA.udid, walletA.bundleId, 'bounds', { label: english.breadPresentationBack });
        expect(bounds.pid).toBe(initial.pid);
        if (!bounds.capsule) throw new Error('Native capsule AX frame is missing');
        const frame = bounds.capsule;
        const start: Point = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
        const peak: Point = {
          x: start.x,
          y: name === 'short-release' ? start.y + 45 : Math.min(bounds.height - 20, start.y + bounds.height * 0.6)
        };
        const points = name === 'reversal' ? [start, peak, peak, start] : [start, peak, peak];
        const beforeCount = await walletA.evalJs<number>(
          'return window.__TEST_DAPP_BROWSER__.nativeMinimizeRequestCount;'
        );
        expect(Number.isSafeInteger(beforeCount)).toBe(true);
        const beforeFile = testInfo.outputPath(`${name}-before.png`);
        await sim.screenshot(walletA.udid, beforeFile);
        const before = await footprint(beforeFile);
        let touching = false;
        let started = false;
        let firstDownMs = 0;
        let beforeUpMs = 0;
        const command = idb(
          walletA.udid,
          walletA.bundleId,
          'path',
          { label: english.breadPresentationBack, expectedPid: initial.pid, points, steps: 30, delayMs: 40 },
          reply => {
            if (reply.phase === 'started') {
              touching = started = true;
              firstDownMs = reply.afterFirstDownMs ?? 0;
            } else if (reply.phase === 'releasing') {
              touching = false;
              beforeUpMs = reply.beforeUpMs ?? 0;
            }
          }
        );
        void command.catch(() => undefined);
        const samples = [];
        let observedTracking = false;
        let nativeResult: NativeReply | undefined;
        try {
          await expect.poll(() => started, { timeout: 20_000 }).toBe(true);
          for (let index = 0; touching && index < 10; index += 1) {
            observedTracking ||= (await driver.state()).motion?.tracking === true;
            const file = testInfo.outputPath(`${name}-during-${index}.png`);
            const captureStartMs = Date.now();
            await sim.screenshot(walletA.udid, file);
            const captureEndMs = Date.now();
            const pixels = await footprint(file);
            samples.push({ file, pixels, captureStartMs, captureEndMs });
          }
        } finally {
          nativeResult = await command;
        }
        if (!nativeResult) throw new Error('Native HID result is missing');
        expect(nativeResult.pid).toBe(initial.pid);
        expect(nativeResult.upSamples).toBe(1);
        expect(nativeResult.downSamples).toBeGreaterThan(1);
        expect(observedTracking, 'actual HID contact must enter native gesture tracking').toBe(true);
        expect(firstDownMs > 0, 'the first native DOWN timestamp must be positive').toBe(true);
        expect(beforeUpMs).toBeGreaterThan(firstDownMs);
        expect(
          samples.some(
            sample =>
              sample.captureStartMs >= firstDownMs &&
              sample.captureEndMs <= beforeUpMs &&
              sample.pixels.count < before.count * 0.97
          ),
          'a native frame must shrink while the finger is still down'
        ).toBe(true);
        const commit = name === 'commit';
        await driver.waitForState(
          'native gesture result on the original session',
          state =>
            state.sessions.length === 1 &&
            state.sessions[0]?.id === initialSession.id &&
            state.sessions[0]?.status === (commit ? 'parked' : 'active') &&
            state.foregroundId === (commit ? null : initialSession.id)
        );
        await driver.waitForMotionIdle();
        const afterCount = await walletA.evalJs<number>(
          'return window.__TEST_DAPP_BROWSER__.nativeMinimizeRequestCount;'
        );
        expect(afterCount - beforeCount).toBe(commit ? 1 : 0);
        expect(fixture.loadCount('alpha')).toBe(1);
        expect((await idb(walletA.udid, walletA.bundleId, 'state', {})).pid).toBe(initial.pid);
        expect(await walletA.evalJs('return Boolean(window.__TEST_DAPP_BROWSER__);')).toBe(true);
        const afterFile = testInfo.outputPath(`${name}-after.png`);
        await sim.screenshot(walletA.udid, afterFile);
        const after = await footprint(afterFile);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        const expectedGeometry = commit
          ? { minimumRatio: 100 / before.count, maximumRatio: 0.8, maximumEdgeShift: before.height }
          : { minimumRatio: 0.95, maximumRatio: 1.05, maximumEdgeShift: 4 };
        expect(after.count / before.count).toBeGreaterThan(expectedGeometry.minimumRatio);
        expect(after.count / before.count).toBeLessThan(expectedGeometry.maximumRatio);
        expect(Math.abs(after.top - before.top)).toBeLessThan(expectedGeometry.maximumEdgeShift);
        expect(Math.abs(after.bottom - before.bottom)).toBeLessThan(expectedGeometry.maximumEdgeShift);
        if (!commit) await driver.expectDappPainted('alpha', `${name}-restored`);
        cases.push({
          name,
          points,
          bounds,
          nativeResult,
          firstDownMs,
          beforeUpMs,
          observedTracking,
          before,
          samples,
          after,
          minimizeDelta: afterCount - beforeCount,
          documentLoads: fixture.loadCount('alpha')
        });
      }
      expect(cases).toHaveLength(3);
      await writeFile(
        testInfo.outputPath('capsule-gesture-cases.json'),
        JSON.stringify(
          {
            sourceSha: process.env.GITHUB_SHA,
            cases,
            caseCount: cases.length,
            initial,
            webviewPrefersReducedMotion: prefersReducedMotion,
            gaps: [
              'native reduced-motion toggle/flag',
              'system-induced touch CANCEL',
              'cross-authority revocation variants'
            ]
          },
          null,
          2
        )
      );
    } finally {
      await fixture.stop();
    }
  });
});
