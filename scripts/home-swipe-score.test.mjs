import assert from 'node:assert/strict';
import test from 'node:test';

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
