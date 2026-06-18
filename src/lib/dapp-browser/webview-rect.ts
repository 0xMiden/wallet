/**
 * Helpers to convert a CSS-pixel `DOMRect` (from `getBoundingClientRect`)
 * into the integer-pixel rect format the InAppBrowser plugin expects.
 *
 * The plugin treats `{x, y, width, height}` as CSS pixels on iOS (UIScreen
 * bounds are in points = CSS px) and as device-independent pixels on Android
 * (the plugin's `getPixels()` converts dp → px internally). For our usage —
 * positioning a webview to fill an HTML slot — passing CSS-px integers works
 * on both platforms.
 *
 * If we hit a DPR-related bug on a specific device, this is the place to add
 * a per-platform conversion.
 */

export interface WebViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Round a DOMRect into the integer rect the plugin expects.
 * Uses Math.round (not floor/ceil) to minimize visible drift during animations.
 */
export function rectFromDOMRect(rect: DOMRect): WebViewRect {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

/**
 * Test rect equality for the rAF-throttle dedupe in the drag/minimize hook.
 */
export function rectsEqual(a: WebViewRect | undefined, b: WebViewRect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
