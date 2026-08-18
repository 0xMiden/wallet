import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { StoryCapture, type ScreenshotTarget } from './story-capture';
import { TestStepRunner } from './test-step';
import { TimelineRecorder } from './timeline-recorder';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'story-'));
}

/** A screenshot target that records the paths it was asked to write. */
function recordingTarget(sink: string[]): ScreenshotTarget {
  return {
    screenshot: async ({ path: p }) => {
      sink.push(path.basename(p));
    }
  };
}

describe('StoryCapture', () => {
  it('writes one ordered, story-named frame per capture', async () => {
    const names: string[] = [];
    const story = new StoryCapture(recordingTarget(names), tmpDir(), 'A');

    await story.capture('create_wallets');
    await story.capture('send-review');

    expect(names).toEqual(['screen-001-create-wallets-wallet-a.png', 'screen-002-send-review-wallet-a.png']);
    expect(story.count()).toBe(2);
  });

  it('is best-effort — a failing target does not throw, and the sequence still advances', async () => {
    const story = new StoryCapture(
      {
        screenshot: async () => {
          throw new Error('page closed mid-navigation');
        }
      },
      tmpDir(),
      'B'
    );

    await expect(story.capture('anything')).resolves.toBeUndefined();
    expect(story.count()).toBe(1);
  });

  it('runs the paint gate before grabbing', async () => {
    const order: string[] = [];
    const story = new StoryCapture(
      { screenshot: async () => void order.push('grab') },
      tmpDir(),
      'A',
      async () => void order.push('paint')
    );

    await story.capture('home');
    expect(order).toEqual(['paint', 'grab']);
  });
});

describe('TestStepRunner story frames', () => {
  it('captures one frame per plain step, and skips the end-shot when the step emitted its own beats', async () => {
    const dir = tmpDir();
    const names: string[] = [];
    const story = new StoryCapture(recordingTarget(names), path.join(dir, 'screens'), 'A');
    const timeline = new TimelineRecorder(dir);
    const runner = new TestStepRunner(timeline, dir);
    runner.registerStoryCapture('A', story);

    await runner.step('sync_wallet', async () => {});
    await runner.step('send_private_note', async () => {
      // a flow emitting its own beats
      await story.capture('send-review');
      await story.capture('send-generating');
    });
    await runner.step('verify_balance', async () => {});

    // sync_wallet → end-shot; send_private_note → only its two beats (no end-shot);
    // verify_balance → end-shot. That reads as the test's story.
    expect(names).toEqual([
      'screen-001-sync-wallet-wallet-a.png',
      'screen-002-send-review-wallet-a.png',
      'screen-003-send-generating-wallet-a.png',
      'screen-004-verify-balance-wallet-a.png'
    ]);

    await timeline.close();
  });

  it('captures a failure frame when a step throws', async () => {
    const dir = tmpDir();
    const names: string[] = [];
    const story = new StoryCapture(recordingTarget(names), path.join(dir, 'screens'), 'A');
    const timeline = new TimelineRecorder(dir);
    const runner = new TestStepRunner(timeline, dir);
    runner.registerStoryCapture('A', story);

    await expect(
      runner.step('broken_step', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(names).toEqual(['screen-001-broken-step-FAILED-wallet-a.png']);

    await timeline.close();
  });
});
