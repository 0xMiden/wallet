import type { TimelineRecorder } from './timeline-recorder';

export interface WaitOptions {
  expected: string;
  maxAttempts?: number;
  intervalMs?: number;
}

export interface WaitResult {
  met: boolean;
  current: string;
}

/**
 * Wait for a condition to be met, logging every attempt to the timeline.
 * Each poll emits a blockchain_state event with severity 'warn' (not yet met) or 'info' (met).
 * On final failure, emits an 'error' event and throws.
 */
export async function waitForCondition(
  timeline: TimelineRecorder,
  wallet: 'A' | 'B',
  description: string,
  checkFn: () => Promise<WaitResult>,
  opts: WaitOptions
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 30;
  const intervalMs = opts.intervalMs ?? 5_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { met, current } = await checkFn();

    timeline.emit({
      category: 'blockchain_state',
      severity: met ? 'info' : attempt === maxAttempts ? 'error' : 'warn',
      wallet,
      message: met
        ? `Condition met: ${description} (attempt ${attempt})`
        : `Waiting: ${description} - expected ${opts.expected}, got ${current} (${attempt}/${maxAttempts})`,
      data: {
        description,
        expected: opts.expected,
        actual: current,
        attempt,
        maxAttempts,
        met,
        intervalMs,
      },
    });

    if (met) return;

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(
    `Condition not met after ${maxAttempts} attempts (${maxAttempts * intervalMs}ms): ` +
      `${description}. Expected: ${opts.expected}`
  );
}
