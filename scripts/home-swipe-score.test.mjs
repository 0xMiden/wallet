import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { analyzeSwipe, frameHealth, homePath, judge, summarize } from './home-swipe-score.mjs';

function framesOf(count, step = 16) {
  return Array.from({ length: count }, (_, i) => i * step);
}

test('homePath normalises the hash router', () => {
  assert.equal(homePath('#/send'), '/send');
  assert.equal(homePath('#/'), '/');
  assert.equal(homePath(''), '/');
  assert.equal(homePath('#/earn/'), '/earn');
});

test('a track that stays with the finger scores low and counts as landed', () => {
  const frames = framesOf(40);
  const contact = frames.filter(t => t >= 32 && t <= 272);
  const finger = contact.map((t, index) => ({
    t,
    x: 480 - index * 8,
    type: index === 0 ? 'down' : index === contact.length - 1 ? 'up' : 'move'
  }));
  const downX = finger[0].x;
  const up = finger[finger.length - 1];
  const xs = frames.map(t => {
    if (t <= up.t) {
      const seen = [...finger].reverse().find(event => event.t <= t && event.type !== 'up');
      return seen ? seen.x - downX : 0;
    }
    const glide = Math.min(t, up.t + 48);
    return up.x - downX - (glide - up.t);
  });
  const result = analyzeSwipe({
    frames,
    xs,
    pings: frames,
    finger,
    routeBefore: '#/',
    routeAfter: '#/send'
  });

  assert.equal(result.committed, true);
  assert.equal(result.reversals, 0);
  assert.equal(result.hitchFrames, 0);
  assert.equal(result.droppedFrames, 0);
  assert.ok(result.followP95Px < 1);
  assert.ok(result.feel < 20);
});

test('a mid-swipe freeze is a hitch even when the surrounding frames are short', () => {
  const frames = framesOf(12);
  const xs = [0, -10, -20, -20, -20, -20, -60, -70, -80, -90, -100, -110];
  const result = analyzeSwipe({
    frames,
    xs,
    finger: [
      { t: 0, x: 100, type: 'down' },
      { t: 160, x: 0, type: 'up' }
    ],
    routeBefore: '#/',
    routeAfter: '#/send'
  });

  assert.equal(result.hitchFrames, 3);
  assert.equal(result.stalls[0].resumeDx, 40);
  assert.ok(result.feel > 40);
});

test('a one-pixel wiggle before the drag starts is not a reversal', () => {
  const frames = framesOf(6);
  const result = analyzeSwipe({
    frames,
    xs: [0, 1, 1, -34, -57, -80],
    finger: [
      { t: 0, x: 200, type: 'down' },
      { t: 80, x: 80, type: 'up' }
    ],
    routeBefore: '#/',
    routeAfter: '#/send'
  });

  assert.equal(result.reversals, 0);
});

test('a direction change mid-flight is a reversal', () => {
  const frames = framesOf(6);
  const result = analyzeSwipe({
    frames,
    xs: [0, -10, -20, -10, 0, 10],
    finger: [
      { t: 0, x: 100, type: 'down' },
      { t: 80, x: 40, type: 'up' }
    ],
    routeBefore: '#/send',
    routeAfter: '#/'
  });

  assert.equal(result.reversals, 1);
});

test('staying on the same page is a miss, ahead of smoothness', () => {
  const frames = framesOf(8);
  const result = analyzeSwipe({
    frames,
    xs: frames.map(() => 0),
    finger: [
      { t: 0, x: 100, type: 'down' },
      { t: 40, x: 20, type: 'up' }
    ],
    routeBefore: '#/',
    routeAfter: '#/'
  });

  assert.equal(result.committed, false);
  assert.ok(result.feel >= 1000);
});

test('frameHealth counts a gap at or above 25ms as dropped', () => {
  assert.equal(frameHealth([0, 16, 32]), null);
  const health = frameHealth([0, 16, 32, 48, 80, 96]);
  assert.equal(health.droppedPct, 20);
  assert.equal(health.p95Ms, 32);
});

test('judge keeps a clear improvement and rejects noise or a missed landing', () => {
  const baseline = summarize([
    { feel: 40, committed: true, reversals: 0, hitchFrames: 2, droppedFrames: 1, followP95Px: 12, worstFrameMs: 40, releaseGapMs: 20 },
    { feel: 44, committed: true, reversals: 0, hitchFrames: 2, droppedFrames: 1, followP95Px: 14, worstFrameMs: 36, releaseGapMs: 18 }
  ]);
  const winner = summarize([
    { feel: 8, committed: true, reversals: 0, hitchFrames: 0, droppedFrames: 0, followP95Px: 4, worstFrameMs: 18, releaseGapMs: 16 },
    { feel: 10, committed: true, reversals: 0, hitchFrames: 0, droppedFrames: 0, followP95Px: 5, worstFrameMs: 18, releaseGapMs: 16 }
  ]);
  const noise = summarize([
    { feel: 36, committed: true, reversals: 0, hitchFrames: 1, droppedFrames: 1, followP95Px: 11, worstFrameMs: 34, releaseGapMs: 18 },
    { feel: 38, committed: true, reversals: 0, hitchFrames: 1, droppedFrames: 1, followP95Px: 12, worstFrameMs: 33, releaseGapMs: 18 }
  ]);
  const missed = summarize([
    { feel: 4, committed: false, reversals: 0, hitchFrames: 0, droppedFrames: 0, followP95Px: 2, worstFrameMs: 16, releaseGapMs: 16 }
  ]);

  assert.equal(judge(baseline, winner).winner, true);
  assert.equal(judge(baseline, noise).winner, false);
  assert.equal(judge(baseline, missed).winner, false);
});

const perfSource = readFileSync(new URL('./ios-frame-perf.cjs', import.meta.url), 'utf8');

// Template literal bodies are read as text because loading the script connects to a device.
function templateAfter(marker) {
  const open = perfSource.indexOf('`', perfSource.indexOf(marker));
  const close = perfSource.indexOf('`;', open);
  const end = marker === 'const RECORDER' ? close : perfSource.indexOf('`', open + 1);
  return vm.runInNewContext('`' + perfSource.slice(open + 1, end) + '`');
}

const recorderCode = templateAfter('const RECORDER');
const probeCode = templateAfter('async function cmdProbe');

function matrixX(transform) {
  if (!transform || transform === 'none') return 0;
  const nums = transform.match(/\((.+)\)/)[1].split(',').map(parseFloat);
  return nums.length === 6 ? nums[4] : nums[12];
}

function recorderWebView(fixture) {
  class Element {
    getBoundingClientRect() {
      return {};
    }
  }
  const make = (props = {}) => Object.assign(new Element(), { firstElementChild: null, scrollLeft: 0 }, props);
  const frames = [];
  const bySelector = {};
  const lookup = sel => bySelector[sel] || null;
  Element.prototype.querySelector = lookup;
  const ctx = {
    Element,
    document: { querySelector: lookup, documentElement: make() },
    MutationObserver: class { observe() {} },
    MessageChannel: class {
      constructor() {
        this.port1 = {};
        this.port2 = { postMessage() {} };
      }
    },
    DOMMatrixReadOnly: class {
      constructor(transform) {
        this.m41 = matrixX(transform);
      }
    },
    performance: { now: () => 0 },
    requestAnimationFrame: cb => frames.push(cb),
    getComputedStyle: el => ({ transform: el._transform })
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  fixture({ make, bySelector });
  return {
    ctx,
    run: code => vm.runInContext(`(function () { ${code}\n})()`, ctx),
    fireFrame: () => frames.splice(0).forEach(cb => cb(16))
  };
}

// The pre-fix recorder, as an already-instrumented WebView still holds it.
const LEGACY_HELPERS = `
  P.findPager = function () { return document.querySelector('div.touch-pan-y'); };
  P.findTrack = function () { var c = P.findPager(); return c ? c.firstElementChild : null; };
  P.readX = function (el) {
    var cs = el ? getComputedStyle(el).transform : null;
    return cs && cs !== 'none' ? parseFloat(cs.match(/\\((.+)\\)/)[1].split(',')[4]) : 0;
  };
`;

test('native flip position is translateX minus scrollLeft', () => {
  const view = recorderWebView(({ make, bySelector }) => {
    const legacyTrack = make({ _transform: 'matrix(1, 0, 0, 1, -40, 0)' });
    bySelector['[data-home-pager]'] = make({ scrollLeft: 780 });
    bySelector['[data-home-track]'] = make({ _transform: 'matrix(1, 0, 0, 1, 390, 0)' });
    bySelector['div.touch-pan-y'] = make({ firstElementChild: legacyTrack });
  });
  view.run(recorderCode);
  view.run('var P = window.__PERF__; P.version = 8;' + LEGACY_HELPERS);
  view.run(recorderCode);
  view.run('window.__PERF__.start();');
  view.fireFrame();
  const P = view.ctx.__PERF__;

  assert.equal(P.xs[0], -390, 'native flip position is translateX minus scrollLeft');
  assert.equal(P.trackFound, true, 'native flip position is translateX minus scrollLeft');
  const probe = JSON.parse(view.run(probeCode));
  assert.equal(probe.readX, -390, 'native flip position is translateX minus scrollLeft');
});

test('legacy framer pager position is the track translateX', () => {
  const view = recorderWebView(({ make, bySelector }) => {
    const track = make({ _transform: 'matrix(1, 0, 0, 1, -80, 0)' });
    bySelector['div.touch-pan-y'] = make({ scrollLeft: 15, firstElementChild: track });
  });
  view.run(recorderCode);
  view.run('window.__PERF__.start();');
  view.fireFrame();

  assert.equal(view.ctx.__PERF__.xs[0], -80, 'legacy framer pager position is the track translateX');
  assert.equal(view.ctx.__PERF__.trackFound, true);
});
