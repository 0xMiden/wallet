import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import { parseWebViewScreenBounds, type ScreenPoint, type ScreenRect } from './native-presentation-coordinates';

export { cssRectCenterToScreen, parseWebViewScreenBounds } from './native-presentation-coordinates';
export type { CssRect, ScreenPoint, ScreenRect } from './native-presentation-coordinates';

const execFileAsync = promisify(execFile);
const ADB_TIMEOUT_MS = 30_000;
const TRACE_DURATION_MS = 90_000;
const TRACE_TAG = 'WalletPresentationE2E';

export async function readWebViewScreenBounds(serial: string, packageName: string): Promise<ScreenRect> {
  const remoteXml = `/sdcard/window-hierarchy-${process.pid}.xml`;
  await adb(serial, ['shell', 'uiautomator', 'dump', remoteXml]);
  try {
    const { stdout } = await adb(serial, ['shell', 'cat', remoteXml]);
    return parseWebViewScreenBounds(stdout, packageName);
  } finally {
    await adb(serial, ['shell', 'rm', '-f', remoteXml]).catch(() => undefined);
  }
}

export async function nativeTap(serial: string, point: ScreenPoint): Promise<void> {
  if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || point.x < 0 || point.y < 0) {
    throw new Error('Native Android tap coordinates must be non-negative safe integers');
  }
  await adb(serial, ['shell', 'input', 'tap', String(point.x), String(point.y)]);
}

export async function markFrameTimeline(serial: string, message: string): Promise<void> {
  if (!/^trial-[1-5]-(start|end)$/.test(message)) throw new Error('Invalid frame timeline marker');
  await adb(serial, ['shell', 'log', '-p', 'i', '-t', TRACE_TAG, message]);
}

export async function captureFrameTimeline(
  serial: string,
  tracePath: string,
  exercise: () => Promise<void>
): Promise<void> {
  await fs.mkdir(path.dirname(tracePath), { recursive: true });
  const stem = path.basename(tracePath).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const remoteConfig = `/data/local/tmp/${stem}.pbtxt`;
  const remoteTrace = `/data/local/tmp/${stem}`;
  const configPath = `${tracePath}.pbtxt`;
  await fs.writeFile(
    configPath,
    [
      'buffers { size_kb: 8192 fill_policy: RING_BUFFER }',
      `duration_ms: ${TRACE_DURATION_MS}`,
      'data_sources { config { name: "android.surfaceflinger.frametimeline" } }',
      `data_sources { config { name: "android.log" android_log_config { min_prio: PRIO_INFO filter_tags: "${TRACE_TAG}" log_ids: LID_MAIN } } }`,
      ''
    ].join('\n')
  );
  await adb(serial, ['push', configPath, remoteConfig]);

  const child = spawn('adb', ['-s', serial, 'shell', 'perfetto', '--txt', '-c', remoteConfig, '-o', remoteTrace], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => (stdout += String(chunk)));
  child.stderr?.on('data', chunk => (stderr += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let exerciseError: unknown;
  try {
    await delay(1_500);
    if (child.exitCode !== null) throw new Error(`Perfetto exited before tracing: ${stdout} ${stderr}`.trim());
    await exercise();
  } catch (error) {
    exerciseError = error;
  }

  try {
    const result = await withTimeout(exited, TRACE_DURATION_MS + ADB_TIMEOUT_MS, () => child.kill('SIGTERM'));
    if (result.code !== 0)
      throw new Error(`Perfetto failed (exit=${result.code}, signal=${result.signal}): ${stderr}`.trim());
    await adb(serial, ['pull', remoteTrace, tracePath]);
    if ((await fs.stat(tracePath)).size === 0) throw new Error('Perfetto produced an empty FrameTimeline trace');
  } finally {
    await adb(serial, ['shell', 'rm', '-f', remoteConfig, remoteTrace]).catch(() => undefined);
  }
  if (exerciseError) throw exerciseError;
}

async function adb(serial: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('adb', ['-s', serial, ...args], { timeout: ADB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Perfetto capture exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
