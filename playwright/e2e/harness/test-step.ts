import * as fs from 'fs';
import * as path from 'path';

import { captureAndSaveSnapshot } from './state-snapshot';
import type { StoryCapture } from './story-capture';
import type { TimelineRecorder } from './timeline-recorder';
import type { Checkpoint, FailureCategory, SnapshotCaps, StepOptions } from './types';

/**
 * Classify an error into a FailureCategory for diagnostic hints.
 */
function classifyError(error: Error): FailureCategory {
  const msg = error.message.toLowerCase();
  const stack = (error.stack ?? '').toLowerCase();

  if (msg.includes('timeout') && (msg.includes('waiting for') || msg.includes('selector'))) {
    return 'ui_element_not_found';
  }
  if (msg.includes('expected') && msg.includes('received')) {
    return 'assertion_value_mismatch';
  }
  if (msg.includes('condition not met') && msg.includes('sync')) {
    return 'timeout_waiting_for_sync';
  }
  if (msg.includes('condition not met')) {
    return 'timeout_waiting_for_transaction';
  }
  if (msg.includes('exit code') || msg.includes('miden-client')) {
    return 'cli_command_failed';
  }
  if (msg.includes('net::') || msg.includes('econnrefused') || msg.includes('fetch failed')) {
    return 'network_error';
  }
  if (stack.includes('recursive use of an object') || stack.includes('wasm')) {
    return 'browser_console_error';
  }
  if (msg.includes('page closed') || msg.includes('target closed') || msg.includes('crashed')) {
    return 'extension_crash';
  }
  return 'unknown';
}

interface SnapshotCapsMap {
  A?: SnapshotCaps;
  B?: SnapshotCaps;
}

/**
 * Test step runner that wraps test code in named checkpoints
 * with automatic screenshot and state capture.
 */
export class TestStepRunner {
  private checkpoints: Checkpoint[] = [];
  private storyCaptures: { A?: StoryCapture; B?: StoryCapture } = {};
  /** Public for fixture failure-path reuse (e.g., direct snapshot in teardown). */
  readonly walletCaps: SnapshotCapsMap;

  constructor(
    private timeline: TimelineRecorder,
    readonly outputDir: string,
    walletCaps: SnapshotCapsMap = {}
  ) {
    this.walletCaps = walletCaps;
  }

  /**
   * Register snapshot capabilities for a wallet. The fixture pre-binds
   * platform-specific closures (page.evaluate, context.serviceWorkers, etc.)
   * before any step runs, so test-step itself stays runtime-agnostic.
   */
  registerSnapshotCaps(label: 'A' | 'B', caps: SnapshotCaps): void {
    this.walletCaps[label] = caps;
  }

  /**
   * Register a wallet's story filmstrip. Once registered, every step captures a
   * frame (captioned by the step name) after it succeeds — unless the step
   * already emitted its own beats via the flow (send/swap/claim), in which case
   * those beats ARE that step's story and the redundant end-shot is skipped.
   */
  registerStoryCapture(label: 'A' | 'B', capture: StoryCapture): void {
    this.storyCaptures[label] = capture;
  }

  /**
   * Execute a named test step with optional screenshot/state capture on completion.
   * Screenshots and state are captured AFTER the step function succeeds.
   * On failure, the error is recorded and re-thrown.
   */
  async step(name: string, fn: () => Promise<void>, options: StepOptions = {}): Promise<void> {
    this.timeline.enterStep(name);
    const start = Date.now();
    const checkpoint: Checkpoint = {
      index: this.timeline.currentStep,
      name,
      status: 'passed',
      startedAt: new Date().toISOString(),
      completedAt: '',
      durationMs: 0,
      assertions: []
    };

    // Snapshot each wallet's story length so we can tell, after the step, which
    // wallets emitted their own beats during it (and thus don't need an end-shot).
    const storyBefore = {
      A: this.storyCaptures.A?.count() ?? 0,
      B: this.storyCaptures.B?.count() ?? 0
    };

    try {
      await fn();

      // Story frame: one shot per step, captioned by the step name — skipped for
      // a wallet whose flow already emitted beats during this step, so send/swap/
      // claim steps tell their review→generating→receipt sub-story instead.
      for (const label of ['A', 'B'] as const) {
        const sc = this.storyCaptures[label];
        if (sc && sc.count() === storyBefore[label]) await sc.capture(name);
      }

      // Capture screenshots after successful step
      if (options.screenshotWallets) {
        const screenshotsDir = path.join(this.outputDir, 'screenshots');
        fs.mkdirSync(screenshotsDir, { recursive: true });

        for (const { target, label } of options.screenshotWallets) {
          const filename = `step-${checkpoint.index}-${name}-wallet-${label.toLowerCase()}.png`;
          try {
            // Diagnostic capture only. A page the step itself tore down
            // (kill()/reopen() in the resilience specs) must not fail an
            // otherwise-successful step — skip the shot if it's already closed.
            await target.screenshot({ path: path.join(screenshotsDir, filename) });
            checkpoint.screenshotPaths = checkpoint.screenshotPaths ?? {};
            if (label === 'A') checkpoint.screenshotPaths.walletA = filename;
            else checkpoint.screenshotPaths.walletB = filename;
          } catch {
            // page closed (or context gone) — screenshot is best-effort
          }
        }
      }

      // Capture state snapshots
      if (options.captureStateFrom) {
        for (const { label } of options.captureStateFrom) {
          const caps = this.walletCaps[label];
          if (!caps) continue;

          const filename = await captureAndSaveSnapshot(
            caps,
            label,
            checkpoint.index,
            name,
            this.outputDir,
            this.timeline
          );
          checkpoint.stateSnapshotPaths = checkpoint.stateSnapshotPaths ?? {};
          if (label === 'A') checkpoint.stateSnapshotPaths.walletA = filename;
          else checkpoint.stateSnapshotPaths.walletB = filename;
        }
      }
    } catch (error: any) {
      checkpoint.status = 'failed';
      checkpoint.error = {
        message: error.message,
        stack: error.stack ?? '',
        category: classifyError(error)
      };

      this.timeline.emit({
        category: 'error',
        severity: 'error',
        message: `Step "${name}" failed: ${error.message}`,
        data: {
          errorName: error.name,
          errorMessage: error.message,
          category: checkpoint.error.category
        }
      });

      // Capture failure screenshots
      if (options.screenshotWallets) {
        const screenshotsDir = path.join(this.outputDir, 'screenshots');
        fs.mkdirSync(screenshotsDir, { recursive: true });

        for (const { target, label } of options.screenshotWallets) {
          try {
            const filename = `failure-wallet-${label.toLowerCase()}.png`;
            await target.screenshot({ path: path.join(screenshotsDir, filename) });
          } catch {
            // target may be closed
          }
        }
      }

      // Story frame marking where the test broke (best-effort; never masks the error).
      for (const label of ['A', 'B'] as const) {
        await this.storyCaptures[label]?.capture(`${name}-FAILED`);
      }

      throw error;
    } finally {
      checkpoint.completedAt = new Date().toISOString();
      checkpoint.durationMs = Date.now() - start;
      this.checkpoints.push(checkpoint);
    }
  }

  /**
   * Get all recorded checkpoints.
   */
  getCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /**
   * Save checkpoints to disk.
   */
  saveCheckpoints(): void {
    const filePath = path.join(this.outputDir, 'checkpoints.json');
    fs.writeFileSync(filePath, JSON.stringify(this.checkpoints, null, 2));
  }
}
