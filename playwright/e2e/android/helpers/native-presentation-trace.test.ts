import { cssRectCenterToScreen, parseWebViewScreenBounds } from './native-presentation-coordinates';
import { buildFrameTimelineConfig } from './native-presentation-trace';

describe('native presentation trace helpers', () => {
  it('uses the Perfetto Android main log buffer enum', () => {
    expect(buildFrameTimelineConfig()).toContain('log_ids: LID_DEFAULT');
  });

  it('uses the largest WebView belonging to the wallet package', () => {
    const xml = [
      '<hierarchy>',
      '<node package="com.other" class="android.webkit.WebView" bounds="[0,0][1080,2400]" />',
      '<node package="com.miden.wallet" class="android.webkit.WebView" bounds="[8,96][1072,2304]" />',
      '<node package="com.miden.wallet" class="android.webkit.WebView" bounds="[10,100][400,500]" />',
      '</hierarchy>'
    ].join('');

    expect(parseWebViewScreenBounds(xml, 'com.miden.wallet')).toEqual({ left: 8, top: 96, right: 1072, bottom: 2304 });
  });

  it('maps the CSS rectangle center through device pixel ratio and WebView screen offset', () => {
    expect(
      cssRectCenterToScreen(
        { x: 10, y: 20, width: 100, height: 40 },
        { left: 8, top: 96, right: 1072, bottom: 2304 },
        3
      )
    ).toEqual({ x: 188, y: 216 });
  });

  it('rejects missing or invalid native bounds and out-of-WebView taps', () => {
    expect(() => parseWebViewScreenBounds('<hierarchy/>', 'com.miden.wallet')).toThrow(/did not expose a WebView/);
    expect(() =>
      cssRectCenterToScreen({ x: 500, y: 0, width: 100, height: 20 }, { left: 8, top: 96, right: 300, bottom: 700 }, 2)
    ).toThrow(/falls outside/);
    expect(() =>
      cssRectCenterToScreen({ x: 0, y: 0, width: 0, height: 20 }, { left: 0, top: 0, right: 200, bottom: 400 }, 1)
    ).toThrow(/invalid CSS rectangle/);
  });
});
