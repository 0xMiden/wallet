import type { Page } from '@playwright/test';

import type { ProveMarker } from './prove-telemetry-probe';

/**
 * Does a page keep painting while the offscreen document proves locally (#945)?
 *
 * Chrome runs every frame of an extension in one renderer process, so a prove that
 * spins the offscreen document's main thread also stops the wallet tab from painting.
 * The page records a `Date.now()` stamp per animation frame; the offscreen realm marks
 * where its local prove starts and ends (`local-prove-window open` / `close`); the
 * largest gap between frames inside that window is the freeze a user saw.
 */

/** 32768 frames at 120 Hz is about four and a half minutes, longer than any E2E prove. */
export const FRAME_CAPACITY = 32768;

export interface ProveWindow {
  openTs: number;
  closeTs: number;
  /** Windows opened between arming and the first close; exactly one is expected. */
  opens: number;
}

export interface FrameGap {
  windowMs: number;
  framesInWindow: number;
  maxGapMs: number;
}

/** Start stamping every animation frame of `page` into a preallocated buffer. */
export async function installFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(capacity => {
    const recorder = { times: new Float64Array(capacity), count: 0 };
    Reflect.set(window, '__MIDEN_FRAME_RECORDER__', recorder);
    const tick = () => {
      if (recorder.count < recorder.times.length) recorder.times[recorder.count++] = Date.now();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, FRAME_CAPACITY);
}

/** The frame stamps recorded so far. Throws if the page reloaded and lost the recorder. */
export async function readFrameTimes(page: Page): Promise<number[]> {
  const times = await page.evaluate(() => {
    const recorder: unknown = Reflect.get(window, '__MIDEN_FRAME_RECORDER__');
    if (typeof recorder !== 'object' || recorder === null || !('times' in recorder) || !('count' in recorder)) {
      return null;
    }
    const { times: stamps, count } = recorder;
    return stamps instanceof Float64Array && typeof count === 'number' ? Array.from(stamps.subarray(0, count)) : null;
  });
  if (times === null) throw new Error('frame recorder missing: the page reloaded after it was installed');
  return times;
}

/** The first local-prove window that closes after `armedAt`, or undefined while none has. */
export function findProveWindow(markers: ProveMarker[], armedAt: number): ProveWindow | undefined {
  let openTs: number | undefined;
  let opens = 0;
  for (const { ts, line } of markers) {
    if (ts < armedAt) continue;
    if (line.includes('local-prove-window open')) {
      opens++;
      openTs ??= ts;
    } else if (line.includes('local-prove-window close') && openTs !== undefined) {
      return { openTs, closeTs: ts, opens };
    }
  }
  return undefined;
}

/**
 * The longest stretch without a frame inside [openTs, closeTs]: the lead-in from open
 * to the first frame, every gap between frames, and the tail to close. A window with
 * no frame at all is one gap as long as the window.
 *
 * Throws if `frames` is exactly `FRAME_CAPACITY` long: the recorder stopped stamping
 * once its preallocated buffer filled, so the true tail is missing and any gap this
 * would report is an artifact of the saturated buffer, not a real freeze.
 */
export function measureFrameGap(frames: number[], openTs: number, closeTs: number): FrameGap {
  if (frames.length === FRAME_CAPACITY) {
    throw new Error(
      `frame recorder buffer saturated: all ${FRAME_CAPACITY} preallocated slots filled, so the reported ` +
        'gap would be measuring a full buffer, not a real freeze'
    );
  }
  const inWindow = frames.filter(ts => ts >= openTs && ts <= closeTs);
  const windowMs = closeTs - openTs;
  if (inWindow.length === 0) return { windowMs, framesInWindow: 0, maxGapMs: windowMs };
  let maxGapMs = 0;
  let previous = openTs;
  for (const ts of inWindow) {
    maxGapMs = Math.max(maxGapMs, ts - previous);
    previous = ts;
  }
  maxGapMs = Math.max(maxGapMs, closeTs - previous);
  return { windowMs, framesInWindow: inWindow.length, maxGapMs };
}

/** The `threads` a `prove-worker ready` marker after `armedAt` reports, if one was recorded. */
export function readyWorkerThreads(markers: ProveMarker[], armedAt: number): number | undefined {
  for (const { ts, line } of markers) {
    if (ts < armedAt) continue;
    const match = /prove-worker ready threads=(\d+) coi=true /.exec(line);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}
