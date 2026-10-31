export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export function parseWebViewScreenBounds(xml: string, packageName: string): ScreenRect {
  const candidates: ScreenRect[] = [];
  for (const node of xml.match(/<node\b[^>]*>/g) ?? []) {
    const attribute = (name: string): string | undefined => node.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    if (attribute('package') !== packageName || !attribute('class')?.endsWith('.WebView')) continue;
    const bounds = attribute('bounds')?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
    if (!bounds) continue;
    const rect = {
      left: Number(bounds[1]),
      top: Number(bounds[2]),
      right: Number(bounds[3]),
      bottom: Number(bounds[4])
    };
    if (rect.right > rect.left && rect.bottom > rect.top) candidates.push(rect);
  }
  candidates.sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));
  const bounds = candidates[0];
  if (!bounds) throw new Error(`Android accessibility hierarchy did not expose a WebView for ${packageName}`);
  return bounds;
}

export function cssRectCenterToScreen(rect: CssRect, webView: ScreenRect, devicePixelRatio: number): ScreenPoint {
  const values = [rect.x, rect.y, rect.width, rect.height, devicePixelRatio];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || devicePixelRatio <= 0) {
    throw new Error('Cannot map an invalid CSS rectangle to Android screen coordinates');
  }
  const x = webView.left + Math.round((rect.x + rect.width / 2) * devicePixelRatio);
  const y = webView.top + Math.round((rect.y + rect.height / 2) * devicePixelRatio);
  if (x < webView.left || x >= webView.right || y < webView.top || y >= webView.bottom) {
    throw new Error('The dApp card center falls outside the native WebView bounds');
  }
  return { x, y };
}
