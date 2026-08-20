import { registerPlugin } from '@capacitor/core';

import { isMobile } from 'lib/platform';

interface RefreshRateInfo {
  maxFps: number;
  minimumFrameDurationDisabled: boolean;
  boostActive: boolean;
}

interface RefreshRateMeasurement {
  observedFps: number;
  medianFrameMs: number;
  worstFrameMs: number;
  frames: number;
  maxFps: number;
  boostActive: boolean;
}

interface HighRefreshRatePlugin {
  boost(options: { durationMs: number }): Promise<{ maxFps: number }>;
  measure(options: { durationMs: number }): Promise<RefreshRateMeasurement>;
  info(): Promise<RefreshRateInfo>;
}

const HighRefreshRate = registerPlugin<HighRefreshRatePlugin>('HighRefreshRate');

/**
 * Asks iOS for the display's full refresh rate for the next `durationMs`.
 *
 * Only worth calling around an animation that runs on the web view's compositor
 * — a Web Animations API transform, or a CSS animation. Anything driven from
 * JavaScript, Framer Motion included, is capped at 60Hz by WebKit regardless
 * (WebKit bug 294338), so boosting around it costs battery and buys nothing.
 *
 * Unproven even in the compositor case: a blind A/B could not distinguish it, and
 * no available tool can measure the web view compositor's commit rate to settle it
 * either way. Kept because it is cheap and request-scoped, not because it is
 * demonstrated. Do not extend its use without a way to measure the effect.
 *
 * Fire-and-forget by design: this is cosmetic, so a missing or failing plugin
 * must never affect the animation it was meant to smooth. Repeated calls extend
 * the window rather than stacking, so callers can boost per gesture freely.
 */
export function boostRefreshRate(durationMs: number): void {
  if (!isMobile()) return;
  HighRefreshRate.boost({ durationMs }).catch(() => {
    // Older builds have no such plugin; the animation is unaffected either way.
  });
}

/**
 * Reports the refresh rate the app is actually being served.
 *
 * Exists because this cannot be measured from JavaScript: `requestAnimationFrame`
 * is itself capped at 60Hz, so it can never observe anything faster than itself.
 *
 * Reads Core Animation's callback rate for the app, which is not the same as the
 * web view compositor's commit rate — 120 here means the display is available at
 * 120, not that web content is being composited that often.
 */
export function measureRefreshRate(durationMs = 1000): Promise<RefreshRateMeasurement | null> {
  if (!isMobile()) return Promise.resolve(null);
  return HighRefreshRate.measure({ durationMs }).catch(() => null);
}

export function refreshRateInfo(): Promise<RefreshRateInfo | null> {
  if (!isMobile()) return Promise.resolve(null);
  return HighRefreshRate.info().catch(() => null);
}
