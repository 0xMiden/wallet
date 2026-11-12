import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cssRectCenterToScreen, parseWebViewScreenBounds } from './native-presentation-coordinates';
import { buildFrameTimelineConfig } from './native-presentation-trace';

describe('native presentation trace helpers', () => {
  it('uses the Perfetto Android main log buffer enum', () => {
    expect(buildFrameTimelineConfig()).toContain('log_ids: LID_DEFAULT');
  });

  it('selects wallet FrameTimeline slices by layer name', () => {
    const analyzer = readFileSync(path.resolve(__dirname, '../../../../scripts/analyze-native-frame-timeline.mjs'), 'utf8');

    expect(analyzer).toContain("a.layer_name GLOB 'TX - com.miden.wallet/*'");
    expect(analyzer).not.toContain('JOIN process AS p');
    expect(analyzer).not.toContain("p.name = 'com.miden.wallet'");
    expect(analyzer).toContain('a.upid IS NOT NULL');
    expect(analyzer).toContain('a.dur > 0');
    expect(analyzer).toContain('FrameTimeline query returned no frame rows');
  });

  it('treats Perfetto null jank values as non-janky', () => {
    const analyzer = readFileSync(path.resolve(__dirname, '../../../../scripts/analyze-native-frame-timeline.mjs'), 'utf8');
    expect(analyzer).toContain("!['', 'NULL', '[NULL]', 'None', 'none'].includes(row.jank_type)");
    expect(analyzer).toContain('Before and after trials used different emulator instances');
    expect(analyzer).toContain('Before and after trials do not share a recorded alternating order');
  });

  it('places the start marker after a touch-down lead and ends before screenshot work', () => {
    const helper = readFileSync(path.resolve(__dirname, 'native-presentation-trace.ts'), 'utf8');
    const spec = readFileSync(path.resolve(__dirname, '../tests/dapp-browser.presentation.android.spec.ts'), 'utf8');
    expect(helper).toContain("'motionevent', 'DOWN'");
    expect(helper).toContain('await delay(200)');
    expect(helper).toContain('await beforeUp()');
    expect(helper).toContain("'motionevent', 'UP'");
    const endMarker = spec.indexOf('`trial-${index}-end`)');
    const screenshot = spec.indexOf('`native-presentation-${VARIANT}-${index}`');
    expect(endMarker).toBeGreaterThan(-1);
    expect(screenshot).toBeGreaterThan(endMarker);
  });

  it('reboots the reserved Android device before each comparison variant', () => {
    const setup = readFileSync(path.resolve(__dirname, '../fixtures/global-setup.ts'), 'utf8');
    expect(setup).toContain("process.env.E2E_ANDROID_REBOOT_BEFORE_PRESENTATION === '1'");
    expect(setup).toContain('await emu.reboot(serialA)');
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
