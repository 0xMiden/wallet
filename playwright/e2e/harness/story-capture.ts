import { captureBestEffort } from './screen-capture';

/** The minimal screenshot surface shared by the Chrome `Page` and the mobile POMs. */
export interface ScreenshotTarget {
  screenshot(opts: { path: string }): Promise<unknown>;
}

/**
 * One ordered filmstrip per wallet, telling the test's story.
 *
 * Every frame — whether captured at a named test-step boundary or at an
 * explicit "beat" inside a flow (send review → generating → receipt) — goes
 * through the same `capture(key)` so the sequence numbers stay monotonic and
 * the frames read in test order. Frames are written straight into the run's
 * `screens/` dir with the gallery's own naming (`screen-NNN-<key>-wallet-<x>`),
 * so the gallery generator ingests them unchanged.
 *
 * This replaces the old "screenshot on every screen-key change" capture, which
 * tracked the UI's every twitch (drawers, transient cards) rather than the
 * flow of the test.
 */
export class StoryCapture {
  private seq = 0;

  constructor(
    private readonly target: ScreenshotTarget,
    private readonly dir: string,
    private readonly label: string,
    /**
     * Optional per-platform "wait until the WebView has painted visible text"
     * gate, mirroring the old poll's blank-frame guard. A beat fired right at a
     * navigation can otherwise grab a blank frame; the gallery drops sub-8KB
     * frames, but waiting first keeps the intended screen.
     */
    private readonly waitForPaint?: () => Promise<void>
  ) {}

  /** How many frames this wallet has captured so far (used to skip a redundant step-end shot when a step already emitted beats). */
  count(): number {
    return this.seq;
  }

  /** Capture the current screen as the next frame in this wallet's story. Best-effort — never throws. */
  async capture(key: string): Promise<void> {
    this.seq += 1;
    if (this.waitForPaint) {
      try {
        await this.waitForPaint();
      } catch {
        // proceed anyway — a blank frame is dropped by the gallery's size guard
      }
    }
    await captureBestEffort(
      async p => {
        await this.target.screenshot({ path: p });
      },
      this.dir,
      this.seq,
      key,
      this.label
    );
  }
}
