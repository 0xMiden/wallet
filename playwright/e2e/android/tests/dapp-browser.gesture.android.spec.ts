import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import sharp from 'sharp';

import english from '../../../../public/_locales/en/en.json';
import { DappBrowserDriver } from '../../harness/dapp-browser-driver';
import { fixtureDapp, startDappFixtureServer, type DappFixtureServer } from '../../harness/dapp-fixture-server';
import { AndroidWalletPage } from '../helpers/android-wallet-page';
import { CdpBridge, type CdpSession } from '../helpers/cdp-bridge';
import { EmulatorControl } from '../helpers/emulator-control';

const execFileAsync = promisify(execFile);
const SERIAL = process.env.ANDROID_SERIAL ?? 'emulator-5554';
const PACKAGE = 'com.miden.wallet';
const OUTPUT = 'test-results-presentation-gesture';
let commandId = 0;

interface Point {
  x: number;
  y: number;
}
interface BridgeReply {
  id: number;
  phase: string;
  executed: number;
  inputStartedMs?: number;
  inputEndedMs?: number;
  width: number;
  height: number;
  capsule?: { left: number; top: number; right: number; bottom: number };
}

async function adb(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('adb', ['-s', SERIAL, ...args], { timeout: 30_000 });
  return stdout.trim();
}

function input(command: { op: string; points?: Point[]; steps?: number; label?: string }, phaseChanged?: (phase: string) => void) {
  const id = ++commandId;
  return new Promise<BridgeReply>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 9236 });
    let buffer = '';
    let completed = false;
    socket.setTimeout(30_000, () => socket.destroy(new Error('Native gesture input timed out')));
    socket.on('connect', () => socket.write(JSON.stringify({ id, ...command }) + '\n'));
    socket.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 16_384) return socket.destroy(new Error('Oversized native gesture reply'));
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const reply: BridgeReply = JSON.parse(line);
          if (reply.id !== id) throw new Error('Native gesture command identity mismatch');
          if (reply.phase === 'started' || reply.phase === 'injected') phaseChanged?.(reply.phase);
          else if (reply.phase === 'done') {
            completed = true;
            resolve(reply);
            socket.end();
          }
          else throw new Error('Native gesture input rejected the command');
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!completed) reject(new Error('Native gesture input closed without a result'));
    });
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
  expect(count, 'the composited fixture color must be visible').toBeGreaterThan(100);
  return { count, top, bottom, width: info.width, height: info.height };
}

test.describe('API36 managed presentation gestures', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env.DAPP_PRESENTATION_GESTURE_API36 !== '1',
    'Requires the dedicated live API36 instrumentation lane'
  );
  let fixture: DappFixtureServer;
  let host: CdpSession;
  let page: CdpSession;
  let wallet: AndroidWalletPage;
  let driver: DappBrowserDriver;
  let sessionId: string;
  let pid: string;

  test.beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true });
    expect(await adb('shell', 'getprop', 'ro.build.version.sdk')).toBe('36');
    expect(await adb('shell', 'settings', 'get', 'secure', 'navigation_mode')).toBe('2');
    for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
      expect(Number(await adb('shell', 'settings', 'get', 'global', key))).toBeGreaterThan(0);
    }
    expect(await adb('shell', 'dumpsys', 'package', PACKAGE)).toMatch(/targetSdk=36\b/);
    pid = await adb('shell', 'pidof', PACKAGE);
    expect(pid).toBe(process.env.GESTURE_TARGET_PID);
    const emulator = new EmulatorControl();
    // Instrumentation owns this process. Never terminate, clear or install it here.
    await emulator.launch(SERIAL, PACKAGE);
    expect(await adb('shell', 'pidof', PACKAGE)).toBe(pid);
    host = await CdpBridge.connect({ serial: SERIAL, packageName: PACKAGE, hostPort: 9230 });
    wallet = new AndroidWalletPage({ cdp: host, emulator, serial: SERIAL, packageName: PACKAGE });
    await wallet.createGuardianWallet();
    fixture = await startDappFixtureServer({ deviceHost: '10.0.2.2', fullscreen: true });
    driver = new DappBrowserDriver({ target: wallet, server: fixture, artifactDir: OUTPUT, label: 'api36' });
    await driver.gotoBrowserTab();
    await driver.openViaUrlBar('alpha');
    await driver.expectDappPainted('alpha', 'initial-painted');
    page = await CdpBridge.connect({
      serial: SERIAL,
      packageName: PACKAGE,
      hostPort: 9232,
      pickPageUrl: fixture.urlFor('alpha')
    });
    expect(await page.eval(`return document.querySelector('meta[name="bread-display"]')?.content;`)).toBe('fullscreen');
    expect(await page.eval('return window.__breadPresentationState?.display;')).toBe('fullscreen');
    const session = await driver.foregroundSession();
    if (!session) throw new Error('No live managed fixture session');
    sessionId = session.id;
  });

  test.afterAll(async () => {
    const cleanup = await Promise.allSettled([page?.close(), host?.close(), fixture?.stop()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('Gesture fixture cleanup failed');
  });

  for (const family of ['capsule', 'predictive'] as const) {
    for (const commit of [false, true]) {
      test(`${family} ${commit ? 'commit' : 'cancel'}`, async ({}, testInfo) => {
        if ((await driver.state()).foregroundId === null) await driver.restoreViaPeekCard('alpha');
        await driver.waitForForeground('alpha');
        await driver.waitForMotionIdle();
        await driver.expectDappPainted('alpha', `${family}-ready`);
        expect(await page.eval('return history.length;'), 'page back must not intercept system back').toBe(1);
        expect(await adb('shell', 'pidof', PACKAGE)).toBe(pid);
        const beforeState = await driver.state();
        expect(beforeState.foregroundId).toBe(sessionId);
        const beforeCount = await wallet.evalJs<number>(
          'return window.__TEST_DAPP_BROWSER__.nativeMinimizeRequestCount;'
        );
        expect(Number.isSafeInteger(beforeCount)).toBe(true);
        const bounds = await input({ op: 'bounds', label: english.breadPresentationBack });
        if (!bounds.capsule) throw new Error('Expected exactly one visible native capsule');
        const { width, height, capsule } = bounds;
        const start =
          family === 'capsule'
            ? {
                x: Math.round((capsule.left + capsule.right) / 2),
                y: Math.round((capsule.top + capsule.bottom) / 2)
              }
            : { x: 1, y: Math.round(height / 2) };
        const peak =
          family === 'capsule'
            ? { x: start.x, y: Math.min(height - 50, start.y + Math.round(height * 0.6)) }
            : { x: Math.round(width * 0.75), y: start.y };
        const points = commit ? [start, peak, peak] : [start, peak, peak, start];
        const name = `${family}-${commit ? 'commit' : 'cancel'}`;
        const beforeFile = testInfo.outputPath(`${name}-before.png`);
        await wallet.screenshot({ path: beforeFile });
        const before = await footprint(beforeFile);
        let started = false;
        let injecting = false;
        let finished = false;
        const gesture = input({ op: 'swipe', points, steps: 150 }, phase => {
          if (phase === 'started') started = true;
          injecting = phase === 'started';
        }).finally(() => {
          finished = true;
        });
        void gesture.catch(() => undefined);
        let observedTracking = false;
        const samples = [];
        let nativeResult: BridgeReply | undefined;
        try {
          await expect.poll(() => started, { timeout: 5_000 }).toBe(true);
          for (let index = 0; !finished && injecting && index < 12; index += 1) {
            const state = await driver.state();
            observedTracking ||= state.motion?.tracking === true;
            const shot = testInfo.outputPath(`${name}-during-${index}.png`);
            const captureStartMs = Number.parseFloat(await adb('shell', 'cat', '/proc/uptime')) * 1000;
            await wallet.screenshot({ path: shot });
            const captureEndMs = Number.parseFloat(await adb('shell', 'cat', '/proc/uptime')) * 1000;
            const pixels = await footprint(shot);
            if (!finished && injecting) samples.push({ file: shot, pixels, captureStartMs, captureEndMs });
          }
        } finally {
          nativeResult = await gesture;
          expect(nativeResult.executed).toBe(bounds.executed + 1);
        }
        expect(observedTracking, 'real input must enter native interactive tracking').toBe(true);
        const inputStartedMs = nativeResult?.inputStartedMs;
        const inputEndedMs = nativeResult?.inputEndedMs;
        if (typeof inputStartedMs !== 'number' || typeof inputEndedMs !== 'number') {
          throw new Error('Native gesture timing evidence is missing');
        }
        expect(
          samples.some(
            sample =>
              sample.captureStartMs >= inputStartedMs &&
              sample.captureEndMs <= inputEndedMs &&
              sample.pixels.count < before.count * 0.97
          ),
          'a frame captured during continuous native input must visibly shrink/move the page'
        ).toBe(true);
        await driver.waitForState(
          'gesture outcome on the original session',
          state =>
            state.sessions.length === beforeState.sessions.length &&
            state.sessions.some(
              session => session.id === sessionId && session.status === (commit ? 'parked' : 'active')
            ) &&
            state.foregroundId === (commit ? null : sessionId)
        );
        await driver.waitForMotionIdle();
        const afterCount = await wallet.evalJs<number>(
          'return window.__TEST_DAPP_BROWSER__.nativeMinimizeRequestCount;'
        );
        expect(afterCount).toBe(beforeCount + (commit ? 1 : 0));
        expect(fixture.loadCount('alpha'), 'the gesture must not replace or reload the document').toBe(1);
        expect(await adb('shell', 'pidof', PACKAGE)).toBe(pid);
        expect(await host.eval('return Boolean(window.__TEST_DAPP_BROWSER__);')).toBe(true);
        const afterFile = testInfo.outputPath(`${name}-after.png`);
        await wallet.screenshot({ path: afterFile });
        const after = await footprint(afterFile);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        if (!commit) {
          expect(after.count / before.count).toBeGreaterThan(0.95);
          expect(after.count / before.count).toBeLessThan(1.05);
          expect(Math.abs(after.top - before.top)).toBeLessThan(4);
          expect(Math.abs(after.bottom - before.bottom)).toBeLessThan(4);
          await driver.expectDappPainted('alpha', `${name}-restored`);
        } else expect(after.count).toBeLessThan(before.count * 0.8);
        await writeFile(
          testInfo.outputPath(`${name}.json`),
          JSON.stringify(
            {
              sourceSha: process.env.GITHUB_SHA,
              selector: name,
              family,
              commit,
              sessionId,
              targetPid: pid,
              sdk: 36,
              points,
              segmentSteps: 150,
              observedTracking,
              nativeResult,
              before,
              samples,
              after,
              minimizeDelta: afterCount - beforeCount,
              documentLoads: fixture.loadCount('alpha')
            },
            null,
            2
          )
        );
      });
    }
  }
});
