/**
 * Visual assertions for the dApp-browser suites.
 *
 * WHY this exists rather than DOM assertions: the dApp does NOT live in the
 * wallet's webview. It is a separate native WKWebView / Android WebView that
 * the plugin positions over an invisible HTML slot (`NativeWebViewSlot`). CDP
 * against the wallet therefore sees an EMPTY div where the user sees a dApp —
 * every DOM-level check would pass while the screen is blank, showing the wrong
 * session, or covered by wallet chrome. A composited device screenshot is the
 * only artefact that contains both layers, so it is the only thing that can
 * answer "does this look right".
 *
 * The checks here are deliberately coarse-grained — dominant colour and
 * flatness over a region — not a pixel-diff against a golden image. Golden
 * images on two OS versions × two form factors rot immediately and get
 * `--update-snapshots`'d into meaninglessness; "the slot is filled with the
 * colour of the dApp that is supposed to be foreground, and is not a blank
 * rectangle" is a claim that stays true across cosmetic churn and still fails
 * loudly for the failures that matter:
 *
 *   - nothing painted (white/black slot)          → blank check
 *   - the wrong session foregrounded              → colour check
 *   - the webview parked at the wrong rect        → coverage check
 *   - wallet chrome drawn over the dApp           → coverage check
 */

import sharp from 'sharp';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionStats {
  /** Fraction (0..1) of sampled pixels within tolerance of the expected colour. */
  matchFraction: number;
  /** Mean colour of the region, as `[r, g, b]`. */
  mean: [number, number, number];
  /**
   * Fraction of pixels that are near-white or near-black. A slot that failed to
   * paint reads as ~1 here, which is how "the dApp is a blank rectangle" is
   * caught even when the expected colour is unknown.
   */
  blankFraction: number;
  /** Region actually sampled, in image (device) pixels. */
  sampled: Rect;
}

/** Squared euclidean distance in RGB. Cheap and good enough to separate the
 *  deliberately far-apart fixture colours. */
function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Sample a CSS-pixel region of a device screenshot.
 *
 * `cssViewport` is the wallet webview's CSS viewport size; the scale factor is
 * derived from it rather than assumed, so this works on a 2x iPhone, a 3x Pro
 * Max and an Android emulator at whatever density it booted with — without the
 * caller knowing the DPR.
 *
 * COORDINATE SPACES. `regionCss` is in the wallet webview's CSS space, while
 * the screenshot is in device-screen space. Those two share an origin only when
 * the webview is laid out edge-to-edge from the top of the screen — true on
 * iOS, false on Android, where the WebView starts BELOW the system status bar
 * and the screenshot therefore contains ~40 CSS px of chrome the webview knows
 * nothing about. Horizontally both platforms are full-bleed, which is why
 * `scale` can be derived from the width alone. Pass `offsetCss` to translate a
 * region into screenshot space; `measureVerticalOffsetCss` measures it rather
 * than assuming a per-platform constant.
 */
export async function sampleRegion(
  screenshotPath: string,
  regionCss: Rect,
  cssViewport: { width: number; height: number },
  expected?: [number, number, number],
  opts: { tolerance?: number; insetPx?: number; offsetCss?: { x?: number; y?: number } } = {}
): Promise<RegionStats> {
  const tolerance = opts.tolerance ?? 60;
  // Pull the sample in from the edges: anti-aliased corners, the capsule's
  // rounded mask and a 1px chrome hairline all sit on the boundary and would
  // otherwise drag the mean around for reasons that aren't the thing under test.
  const inset = opts.insetPx ?? 8;

  const image = sharp(screenshotPath);
  const meta = await image.metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (!imgW || !imgH) throw new Error(`[dapp-visual] unreadable screenshot: ${screenshotPath}`);

  const scale = imgW / cssViewport.width;
  const offsetX = opts.offsetCss?.x ?? 0;
  const offsetY = opts.offsetCss?.y ?? 0;

  const left = Math.max(0, Math.round((regionCss.x + offsetX + inset) * scale));
  const top = Math.max(0, Math.round((regionCss.y + offsetY + inset) * scale));
  const width = Math.max(1, Math.min(imgW - left, Math.round((regionCss.width - inset * 2) * scale)));
  const height = Math.max(1, Math.min(imgH - top, Math.round((regionCss.height - inset * 2) * scale)));

  const { data, info } = await image
    .extract({ left, top, width, height })
    // Downscale before reading pixels: the comparison is statistical, and a
    // full-res crop of a 3x screenshot is millions of pixels per assertion.
    .resize({ width: Math.min(120, width), fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const pixels = info.width * info.height;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let matched = 0;
  let blank = 0;

  for (let i = 0; i < pixels; i++) {
    const o = i * channels;
    const px: [number, number, number] = [data[o]!, data[o + 1]!, data[o + 2]!];
    sumR += px[0];
    sumG += px[1];
    sumB += px[2];
    if (expected && dist2(px, expected) <= tolerance * tolerance) matched++;
    const isNearWhite = px[0] > 235 && px[1] > 235 && px[2] > 235;
    const isNearBlack = px[0] < 20 && px[1] < 20 && px[2] < 20;
    if (isNearWhite || isNearBlack) blank++;
  }

  return {
    matchFraction: expected ? matched / pixels : 0,
    mean: [Math.round(sumR / pixels), Math.round(sumG / pixels), Math.round(sumB / pixels)],
    blankFraction: blank / pixels,
    sampled: { x: left, y: top, width, height }
  };
}

/**
 * Measure how far down the screenshot the dApp's painted region actually starts,
 * relative to where the wallet says its slot is — i.e. the vertical translation
 * between the two coordinate spaces described on `sampleRegion`.
 *
 * WHY MEASURE rather than hardcode a per-platform status-bar height: the offset
 * is a property of the device's system chrome (0 on iOS, ~40 CSS px on the CI
 * Android emulator, different again on a device with a display cutout or a
 * taller status bar). A constant would be wrong on the next runner image; the
 * screenshot already contains the answer.
 *
 * HOW: scan downwards for the first row that is predominantly `color`. The strip
 * sampled is the horizontal MIDDLE of the slot, which matters twice over — it
 * skips the generation marker in the top-left corner (whose colour is
 * deliberately not the dApp's), and it skips rounded webview corners.
 *
 * `searchBandCss` bounds how far this will follow the dApp. That bound is the
 * point: a webview parked at genuinely the wrong place must fail an assertion,
 * not be silently tracked. Callers get a thrown error, and the coarse
 * whole-slot checks (`expectDappPainted` / `expectRelayoutMatchesSlot`) remain
 * the oracles for position and size.
 */
export async function measureVerticalOffsetCss(
  screenshotPath: string,
  slotCss: Rect,
  cssViewport: { width: number; height: number },
  color: [number, number, number],
  opts: { tolerance?: number; searchBandCss?: number; minRowFraction?: number } = {}
): Promise<number> {
  const tolerance = opts.tolerance ?? 60;
  const band = opts.searchBandCss ?? 160;
  const minRowFraction = opts.minRowFraction ?? 0.6;

  const image = sharp(screenshotPath);
  const meta = await image.metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (!imgW || !imgH) throw new Error(`[dapp-visual] unreadable screenshot: ${screenshotPath}`);

  const scale = imgW / cssViewport.width;

  // Centre half of the slot, horizontally.
  const left = Math.max(0, Math.round((slotCss.x + slotCss.width * 0.25) * scale));
  const width = Math.max(1, Math.min(imgW - left, Math.round(slotCss.width * 0.5 * scale)));
  const top = Math.max(0, Math.round((slotCss.y - band) * scale));
  const height = Math.max(1, Math.min(imgH - top, Math.round(band * 2 * scale)));

  const { data, info } = await image
    .extract({ left, top, width, height })
    // Narrow horizontally only: row resolution is the measurement, so `fill`
    // keeps every scanline instead of letting sharp shrink height to preserve
    // the aspect ratio.
    .resize({ width: Math.min(24, width), height, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  for (let row = 0; row < info.height; row++) {
    let hits = 0;
    for (let col = 0; col < info.width; col++) {
      const o = (row * info.width + col) * channels;
      const px: [number, number, number] = [data[o]!, data[o + 1]!, data[o + 2]!];
      if (dist2(px, color) <= tolerance * tolerance) hits++;
    }
    if (hits / info.width >= minRowFraction) {
      const foundCssY = (top + row) / scale;
      return foundCssY - slotCss.y;
    }
  }

  throw new Error(
    `[dapp-visual] could not locate a row of rgb(${color.join(',')}) within ${band}px of the slot's top edge ` +
      `(slot y=${Math.round(slotCss.y)}, searched device rows ${top}..${top + height} of ${screenshotPath}). ` +
      `The dApp is not painted where the wallet says its slot is.`
  );
}

/** Formats stats into a failure message that says what was on screen, so a red
 *  run is diagnosable from the log without opening the artefact. */
export function describeStats(stats: RegionStats): string {
  return (
    `mean=rgb(${stats.mean.join(',')}) match=${(stats.matchFraction * 100).toFixed(1)}% ` +
    `blank=${(stats.blankFraction * 100).toFixed(1)}% sampled=${stats.sampled.width}x${stats.sampled.height}px`
  );
}
