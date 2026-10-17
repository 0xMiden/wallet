import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { type CdpSessionWedgedError, isCdpSessionWedgedError } from './cdp-bridge';

const execFileAsync = promisify(execFile);

/** A wedged attach is rare (2 in 3,560 CI attaches), so one relaunch; a second wedge in a row fails the setup. */
export const WEDGED_LAUNCH_ATTEMPTS = 2;

const SCREENSHOT_TIMEOUT_MS = 20_000;
const OS_LOG_TIMEOUT_MS = 45_000;
const OS_LOG_MAX_BUFFER = 64 * 1024 * 1024;
const WEBCONTENT_REPORT_PREFIX = 'com.apple.WebKit.WebContent';
// WebContent and the other WebKit processes log here too; Capacitor's "WebView process terminated" goes to stdout.
const OS_LOG_QUERY = [
  'log',
  'show',
  '--last',
  '5m',
  '--style',
  'compact',
  '--predicate',
  'process == "App" OR process BEGINSWITH "com.apple.WebKit"'
];

/**
 * Runs `launch` and, when its CDP attach wedged (`CdpSessionWedgedError`), launches once more. `onWedged` runs on every
 * wedge, the last one included, so each leaves its evidence; a wedge on the last attempt is thrown as an error that
 * names `name` and its relaunch. Any other error is thrown unchanged.
 */
export async function relaunchOnceIfWedged<T>(
  name: string,
  launch: (attempt: number) => Promise<T>,
  onWedged: (error: CdpSessionWedgedError, attempt: number, relaunching: boolean) => Promise<void>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(attempt);
    } catch (error) {
      if (!isCdpSessionWedgedError(error)) throw error;
      const relaunching = attempt < WEDGED_LAUNCH_ATTEMPTS;
      await onWedged(error, attempt, relaunching);
      if (!relaunching) {
        throw new Error(`${name} was relaunched once and its CDP attach wedged again: ${error.message}`, {
          cause: error
        });
      }
    }
  }
}

export interface WedgeEvidenceOptions {
  udid: string;
  outDir: string;
  /** Epoch ms the wedged attempt started; a crash report older than this belongs to an earlier launch. */
  since: number;
  /** A capture that needs no CDP, such as `simctl io screenshot`; it must stop its own work by `timeoutMs`. */
  screenshot: (outPath: string, timeoutMs: number) => Promise<void>;
  onLog: (message: string) => void;
  /** Where the host writes crash reports, including the simulator's. */
  reportsDir?: string;
}

/**
 * Saves what can tell why the page's main frame was replaced during the attach (the leading hypothesis is a WebContent
 * crash and Capacitor's reload of the WebView): a screenshot, the app's and WebKit's os_log for the last 5 minutes, and
 * any WebContent crash report from this attempt. Each capture is bounded and best-effort; this never throws.
 */
export async function captureWedgeEvidence(options: WedgeEvidenceOptions): Promise<void> {
  const { udid, outDir, since, onLog } = options;
  const reportsDir = options.reportsDir ?? path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
  const capture = async (what: string, run: () => Promise<string>): Promise<void> => {
    try {
      onLog(`[cdp-wedge] ${what}: ${await run()}`);
    } catch (error) {
      onLog(`[cdp-wedge] could not capture ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await capture('output directory', async () => {
    fs.mkdirSync(outDir, { recursive: true });
    return outDir;
  });
  await capture('screenshot', async () => {
    const shot = path.join(outDir, 'screen.png');
    await within(options.screenshot(shot, SCREENSHOT_TIMEOUT_MS), SCREENSHOT_TIMEOUT_MS + 5_000, 'screenshot');
    return shot;
  });
  await capture('app and WebKit os_log', async () => {
    const { stdout } = await within(
      execFileAsync('xcrun', ['simctl', 'spawn', udid, ...OS_LOG_QUERY], {
        timeout: OS_LOG_TIMEOUT_MS,
        maxBuffer: OS_LOG_MAX_BUFFER
      }),
      OS_LOG_TIMEOUT_MS + 5_000,
      'log show'
    );
    const file = path.join(outDir, 'os-log.txt');
    fs.writeFileSync(file, stdout);
    return file;
  });
  await capture('WebContent crash reports', async () => {
    const copied = fs
      .readdirSync(reportsDir)
      .filter(name => name.startsWith(WEBCONTENT_REPORT_PREFIX))
      .filter(name => fs.statSync(path.join(reportsDir, name)).mtimeMs >= since);
    for (const name of copied) fs.copyFileSync(path.join(reportsDir, name), path.join(outDir, name));
    return copied.length === 0 ? `none newer than the launch in ${reportsDir}` : copied.join(', ');
  });
}

function within<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
