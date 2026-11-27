/**
 * Scores one synthetic home-carousel swipe.
 *
 * Frame rate alone is the wrong number. A swipe can deliver a perfect 60Hz
 * trace while the track sits still for a frame, or while it lags the finger
 * by a chunk of the page. Those are what a thumb feels, so the score is built
 * from the track's position, not from frames per second.
 *
 * Lower is better. A swipe that does not land on the neighbouring home page
 * scores as a miss, ahead of any smoothness difference.
 */

const NOISE_PX = 0.4;
const DROPPED_FRAME_MS = 25;
const RELEASE_FREE_MS = 32;
const HITCH_RESUME_PX = 8;
const BLOCK_FREE_MS = 16;
/** Home carousel, left to right. A pass is one swipe across each boundary. */
export const HOME_PATHS = ['/', '/send', '/receive', '/earn', '/swap'];

const round1 = n => Math.round(n * 10) / 10;

export function homePath(hash) {
  let raw = String(hash ?? '').replace(/^#/, '');
  raw = raw.split('?')[0];
  if (!raw || raw === '/') return '/';
  if (!raw.startsWith('/')) raw = `/${raw}`;
  if (raw.length > 1 && raw.endsWith('/')) raw = raw.slice(0, -1);
  return raw;
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[index];
}

/**
 * Frame health of one scroll. A gap at or above the swipe bench's dropped-frame
 * line counts as dropped. Returns null when there are too few frames to judge.
 */
export function frameHealth(frames) {
  const deltas = [];
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i] - frames[i - 1];
    if (Number.isFinite(gap) && gap >= 0) deltas.push(gap);
  }
  if (deltas.length < 4) return null;
  const dropped = deltas.filter(gap => gap >= DROPPED_FRAME_MS).length;
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    droppedPct: round1((dropped / deltas.length) * 100),
    p95Ms: round1(percentile(sorted, 95))
  };
}

function motionSamples(frames, xs) {
  const moves = [];
  for (let i = 1; i < frames.length; i++) {
    if (xs[i] == null || xs[i - 1] == null) continue;
    moves.push({ i, t: frames[i], dx: xs[i] - xs[i - 1] });
  }
  return moves;
}

function reversalsOf(moves, origin) {
  const reversals = [];
  let lastDir = 0;
  let lastMag = 0;
  for (const move of moves) {
    const mag = Math.abs(move.dx);
    if (mag < NOISE_PX) continue;
    const dir = move.dx > 0 ? 1 : -1;
    // A one-pixel wiggle before the drag gets going is not a change of
    // direction a thumb can feel. Both sides have to be a real jump.
    if (lastDir !== 0 && dir !== lastDir && lastMag >= HITCH_RESUME_PX && mag >= HITCH_RESUME_PX) {
      reversals.push({ atMs: Math.round(move.t - origin), dx: round1(move.dx) });
    }
    if (mag >= HITCH_RESUME_PX) {
      lastDir = dir;
      lastMag = mag;
    }
  }
  return reversals;
}

function stallsOf(moves, origin) {
  const stalls = [];
  let run = 0;
  let sawMotion = false;
  for (const move of moves) {
    if (Math.abs(move.dx) < NOISE_PX) {
      run += 1;
      continue;
    }
    if (run >= 2 && sawMotion) {
      stalls.push({
        atMs: Math.round(move.t - origin),
        frames: run,
        resumeDx: round1(Math.abs(move.dx))
      });
    }
    run = 0;
    sawMotion = true;
  }
  return stalls;
}

function releaseGap(frames, xs, upT) {
  let previous = null;
  let dxAtLift = 0;
  for (let i = 0; i < frames.length; i++) {
    if (xs[i] == null) continue;
    if (previous != null) {
      const dx = xs[i] - previous;
      if (frames[i] <= upT) dxAtLift = dx;
      else if (Math.abs(dx) >= NOISE_PX) return frames[i] - upT;
    }
    previous = xs[i];
  }
  // A track that had already stopped when the finger lifted is settled.
  // A track that was moving and then never moves again froze for the rest of
  // the capture, which is the hitch.
  if (Math.abs(dxAtLift) < NOISE_PX) return 0;
  return Math.max(0, frames[frames.length - 1] - upT);
}

function followOf(frames, xs, events) {
  const down = events.find(event => event.type === 'down') ?? events[0];
  const up = [...events].reverse().find(event => event.type === 'up') ?? events[events.length - 1];
  let track0 = null;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] <= down.t && xs[i] != null) track0 = xs[i];
  }
  if (track0 == null) return { followP95Px: null, samples: 0 };

  let cursor = 0;
  const errors = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i];
    if (t < down.t || t > up.t || xs[i] == null) continue;
    while (cursor + 1 < events.length && events[cursor + 1].t <= t && events[cursor + 1].type !== 'up') {
      cursor += 1;
    }
    const finger = events[cursor];
    const expected = track0 + (finger.x - down.x);
    errors.push(Math.abs(xs[i] - expected));
  }
  errors.sort((a, b) => a - b);
  return { followP95Px: round1(percentile(errors, 95)), samples: errors.length };
}

function blockExcess(pings, from, to) {
  let excess = 0;
  for (let i = 1; i < pings.length; i++) {
    if (pings[i] < from || pings[i] > to) continue;
    const gap = pings[i] - pings[i - 1];
    if (gap > BLOCK_FREE_MS) excess += gap - BLOCK_FREE_MS;
  }
  return excess;
}

function landed(routeBefore, routeAfter) {
  const from = HOME_PATHS.indexOf(homePath(routeBefore));
  const to = HOME_PATHS.indexOf(homePath(routeAfter));
  return from !== -1 && to !== -1 && Math.abs(to - from) === 1;
}

function empty(reason) {
  return {
    feel: 1000,
    committed: false,
    followP95Px: null,
    followSamples: 0,
    worstFrameMs: 0,
    medianFrameMs: 0,
    droppedFrames: 0,
    reversals: 0,
    reversalList: [],
    stalls: [],
    hitchFrames: 0,
    releaseGapMs: 0,
    blockExcessMs: 0,
    slowInputMaxMs: 0,
    travelPx: 0,
    error: reason
  };
}

/**
 * @param {object} sample
 * @param {number[]} sample.frames rAF timestamps, page performance.now()
 * @param {(number|null)[]} sample.xs painted page position at each frame (scroll plus track transform)
 * @param {number[]} [sample.pings] main-thread ping times
 * @param {{t:number,x:number,type?:string}[]} sample.finger finger events on the same clock
 * @param {number[]} [sample.inputDelays] trusted-event input delays, ms
 * @param {string} sample.routeBefore
 * @param {string} sample.routeAfter
 */
export function analyzeSwipe(sample) {
  const frames = sample.frames ?? [];
  const xs = sample.xs ?? [];
  const events = sample.finger ?? [];
  if (frames.length < 2 || events.length < 2) return empty('short-trace');
  if (events.some(event => !Number.isFinite(event.t))) return empty('bad-clock');

  const origin = frames[0];
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  const droppedFrames = deltas.filter(delta => delta > DROPPED_FRAME_MS).length;
  const worstFrameMs = round1(Math.max(...deltas));
  const medianFrameMs = round1(median(deltas));

  const moves = motionSamples(frames, xs);
  const reversalList = reversalsOf(moves, origin);
  const stalls = stallsOf(moves, origin);
  const hitchFrames = stalls.filter(stall => stall.resumeDx >= HITCH_RESUME_PX).reduce((sum, stall) => sum + stall.frames, 0);

  const down = events.find(event => event.type === 'down') ?? events[0];
  const up = [...events].reverse().find(event => event.type === 'up') ?? events[events.length - 1];
  const follow = followOf(frames, xs, events);
  const releaseGapMs = round1(releaseGap(frames, xs, up.t));
  const blockExcessMs = round1(blockExcess(sample.pings ?? [], down.t, frames[frames.length - 1]));
  const delays = (sample.inputDelays ?? []).filter(delay => delay >= BLOCK_FREE_MS);
  const slowInputMaxMs = delays.length ? round1(Math.max(...delays)) : 0;

  let startX = null;
  let endX = null;
  for (let i = 0; i < frames.length; i++) {
    if (xs[i] == null) continue;
    if (frames[i] <= down.t) startX = xs[i];
    endX = xs[i];
  }
  const travelPx = startX == null || endX == null ? 0 : round1(endX - startX);
  const committed = landed(sample.routeBefore, sample.routeAfter);

  const followPenalty = follow.samples === 0 ? 200 : 0;
  const followCost = follow.followP95Px ?? 0;
  const feel = round1(
    (committed ? 0 : 1000) +
      followPenalty +
      reversalList.length * 40 +
      hitchFrames * 15 +
      followCost +
      Math.max(0, releaseGapMs - RELEASE_FREE_MS) * 2 +
      droppedFrames * 8 +
      Math.max(0, worstFrameMs - RELEASE_FREE_MS) +
      Math.max(0, blockExcessMs) * 0.25 +
      Math.max(0, slowInputMaxMs - BLOCK_FREE_MS)
  );

  return {
    feel,
    committed,
    followP95Px: follow.followP95Px,
    followSamples: follow.samples,
    worstFrameMs,
    medianFrameMs,
    droppedFrames,
    reversals: reversalList.length,
    reversalList: reversalList.slice(0, 6),
    stalls: stalls.slice(0, 6),
    hitchFrames,
    releaseGapMs,
    blockExcessMs,
    slowInputMaxMs,
    travelPx,
    trace: frames
      .map((t, index) => [Math.round(t - origin), xs[index] == null ? null : Math.round(xs[index])])
      .filter(([t]) => t <= 400)
      .slice(0, 40)
  };
}

export function summarize(swipes) {
  return {
    swipes: swipes.length,
    commits: swipes.filter(swipe => swipe.committed).length,
    reversals: swipes.reduce((sum, swipe) => sum + swipe.reversals, 0),
    hitchFrames: swipes.reduce((sum, swipe) => sum + swipe.hitchFrames, 0),
    droppedFrames: swipes.reduce((sum, swipe) => sum + swipe.droppedFrames, 0),
    medianFeel: round1(median(swipes.map(swipe => swipe.feel))),
    medianFollowP95Px: round1(median(swipes.map(swipe => swipe.followP95Px ?? 0))),
    medianWorstFrameMs: round1(median(swipes.map(swipe => swipe.worstFrameMs))),
    medianReleaseGapMs: round1(median(swipes.map(swipe => swipe.releaseGapMs)))
  };
}

/**
 * A winner has to land every swipe, keep the finger-follow from getting worse,
 * and beat the baseline by enough that one noisy run would not flip it.
 */
export function judge(baseline, candidate) {
  if (candidate.commits !== candidate.swipes) {
    return { winner: false, reason: 'candidate missed a page landing' };
  }
  if (baseline.commits !== baseline.swipes) {
    return { winner: false, reason: 'baseline missed a page landing, so this is not a feel comparison' };
  }
  if (candidate.medianFollowP95Px > baseline.medianFollowP95Px + 8) {
    return { winner: false, reason: 'the track lagged the finger more' };
  }
  const delta = baseline.medianFeel - candidate.medianFeel;
  const relative = baseline.medianFeel > 0 ? delta / baseline.medianFeel : 0;
  if (delta >= 8 && relative >= 0.15) {
    return {
      winner: true,
      reason: `feel ${baseline.medianFeel} -> ${candidate.medianFeel}`
    };
  }
  return {
    winner: false,
    reason: `within noise (${baseline.medianFeel} -> ${candidate.medianFeel})`
  };
}

/**
 * Home tab taps, in order. A pass starts on Overview and taps each of these;
 * the last tap is the four-page jump back to Overview.
 */
export const TAP_PATH = ['/', '/send', '/receive', '/earn', '/swap', '/'];
const TAP_WINDOW_MS = 700;
const TAP_SETTLED = 0.995;
const TAP_MOVED_OPACITY = 0.01;
const TAP_MOVED_PX = 1;
const TAP_VISIBLE = 0.05;

function paneDistance(pane, final, width) {
  if (!pane || !final) return 0;
  return (
    Math.abs(pane.left - final.left) / width + Math.abs(pane.width - final.width) / width + Math.abs(pane.opacity - final.opacity)
  );
}

function lastAtOrBefore(frames, t) {
  let index = -1;
  for (let i = 0; i < frames.length; i++) if (frames[i] <= t) index = i;
  return index;
}

/**
 * Progress of a tap from what is drawn: 0 at the tap, 1 once both panes stop
 * changing. Rect and effective opacity together, so a slide and a fade are
 * measured on the same scale.
 */
export function tapProgress(sample) {
  const { frames, leave, enter, tabWidth: width, t0 } = sample;
  const last = frames.length - 1;
  const start = Math.max(0, lastAtOrBefore(frames, t0));
  const distance = i => paneDistance(leave[i], leave[last], width) + paneDistance(enter[i], enter[last], width);
  const total = distance(start);
  return frames.map((_, i) => (total <= 0 ? 1 : 1 - distance(i) / total));
}

function moved(pane, before) {
  if (!pane || !before) return false;
  return (
    Math.abs(pane.opacity - before.opacity) >= TAP_MOVED_OPACITY ||
    Math.abs(pane.left - before.left) >= TAP_MOVED_PX ||
    Math.abs(pane.width - before.width) >= TAP_MOVED_PX
  );
}

function overlapsTab(pane, tabLeft, tabWidth) {
  return Math.min(pane.left + pane.width, tabLeft + tabWidth) - Math.max(pane.left, tabLeft) > 1;
}

function emptyTap(reason) {
  return {
    tapFeel: 1000,
    landed: false,
    firstFrameMs: TAP_WINDOW_MS,
    settleMs: TAP_WINDOW_MS,
    droppedFrames: 0,
    worstFrameMs: 0,
    stallFrames: 0,
    reversals: 0,
    blockExcessMs: 0,
    slowInputMaxMs: 0,
    bothVisibleFrames: 0,
    error: reason
  };
}

/**
 * Scores one tab tap from per-frame samples of the leaving and entering panes.
 *
 * @param {object} sample
 * @param {number[]} sample.frames rAF timestamps, page clock
 * @param {({left:number,width:number,opacity:number}|null)[]} sample.leave leaving pane per frame
 * @param {({left:number,width:number,opacity:number}|null)[]} sample.enter entering pane per frame
 * @param {number} sample.tabLeft left edge of the Home tab pane
 * @param {number} sample.tabWidth width of the Home tab pane
 * @param {number} sample.t0 touchEnd, page clock
 * @param {boolean} sample.landed the page's own end-state check
 * @param {number[]} [sample.pings]
 * @param {number[]} [sample.inputDelays]
 */
export function analyzeTap(sample) {
  const frames = sample.frames ?? [];
  const leave = sample.leave ?? [];
  const enter = sample.enter ?? [];
  if (frames.length < 4 || leave.length !== frames.length || enter.length !== frames.length) return emptyTap('short-trace');
  if (!Number.isFinite(sample.t0) || !(sample.tabWidth > 0)) return emptyTap('bad-clock');
  const { t0, tabLeft = 0, tabWidth } = sample;
  const p = tapProgress(sample);

  const startIndex = Math.max(0, lastAtOrBefore(frames, t0));
  let firstFrameMs = TAP_WINDOW_MS;
  for (let i = startIndex + 1; i < frames.length; i++) {
    if (moved(leave[i], leave[startIndex]) || moved(enter[i], enter[startIndex])) {
      firstFrameMs = Math.max(0, frames[i] - t0);
      break;
    }
  }

  let settleIndex = frames.length - 1;
  while (settleIndex > startIndex && p[settleIndex - 1] >= TAP_SETTLED) settleIndex -= 1;
  const settleMs = Math.max(0, frames[settleIndex] - t0);

  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i] > t0 && frames[i] <= t0 + TAP_WINDOW_MS) gaps.push(frames[i] - frames[i - 1]);
  }
  const droppedFrames = gaps.filter(gap => gap > DROPPED_FRAME_MS).length;
  const worstFrameMs = gaps.length ? round1(Math.max(...gaps)) : 0;

  let stallFrames = 0;
  let run = 0;
  let reversals = 0;
  let bothVisibleFrames = 0;
  for (let i = startIndex + 1; i < frames.length; i++) {
    const dp = p[i] - p[i - 1];
    if (p[i] > 0.02 && p[i] < 0.98 && Math.abs(dp) < 0.002) run += 1;
    else {
      if (run >= 2) stallFrames += run;
      run = 0;
    }
    if (dp < -0.02 && p[i] < 0.9) reversals += 1;
  }
  if (run >= 2) stallFrames += run;
  for (let i = 0; i < frames.length; i++) {
    const a = leave[i];
    const b = enter[i];
    if (!a || !b) continue;
    if (
      a.opacity > TAP_VISIBLE &&
      b.opacity > TAP_VISIBLE &&
      overlapsTab(a, tabLeft, tabWidth) &&
      overlapsTab(b, tabLeft, tabWidth)
    ) {
      bothVisibleFrames += 1;
    }
  }

  const blockExcessMs = round1(blockExcess(sample.pings ?? [], t0, t0 + TAP_WINDOW_MS));
  const delays = (sample.inputDelays ?? []).filter(delay => delay >= BLOCK_FREE_MS);
  const slowInputMaxMs = delays.length ? round1(Math.max(...delays)) : 0;
  const landedTap = sample.landed === true;

  const tapFeel = round1(
    (landedTap ? 0 : 1000) +
      reversals * 40 +
      stallFrames * 15 +
      droppedFrames * 8 +
      Math.max(0, worstFrameMs - RELEASE_FREE_MS) +
      Math.max(0, firstFrameMs - RELEASE_FREE_MS) * 2 +
      blockExcessMs * 0.25 +
      Math.max(0, slowInputMaxMs - BLOCK_FREE_MS)
  );

  return {
    tapFeel,
    landed: landedTap,
    firstFrameMs: round1(firstFrameMs),
    settleMs: round1(settleMs),
    droppedFrames,
    worstFrameMs,
    stallFrames,
    reversals,
    blockExcessMs,
    slowInputMaxMs,
    bothVisibleFrames
  };
}

export function summarizeTaps(taps) {
  const sum = key => taps.reduce((total, tap) => total + tap[key], 0);
  return {
    taps: taps.length,
    landed: taps.filter(tap => tap.landed).length,
    medianTapFeel: round1(median(taps.map(tap => tap.tapFeel))),
    medianFirstFrameMs: round1(median(taps.map(tap => tap.firstFrameMs))),
    medianSettleMs: round1(median(taps.map(tap => tap.settleMs))),
    droppedFrames: sum('droppedFrames'),
    reversals: sum('reversals'),
    stallFrames: sum('stallFrames'),
    bothVisibleFrames: sum('bothVisibleFrames')
  };
}
