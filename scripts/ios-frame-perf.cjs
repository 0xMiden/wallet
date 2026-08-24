/**
 * Animation smoothness probe for a physical iOS device.
 *
 * Attaches to the running app's WebView over the RemoteXPC WebInspector tunnel
 * and injects a recorder that samples frame timings, main-thread blocking, and
 * the carousel's actual on-screen position. It can also drive gestures itself, so
 * a regression can be reproduced without a human swiping on cue.
 *
 * Why position and not just frame timings: the stutter this was built to chase
 * showed up as perfectly healthy 60Hz frames where the track simply didn't move
 * for one of them. Frame-rate metrics alone score that as flawless.
 *
 * Prerequisite (one-time per boot, needs root to create the TUN interface):
 *   cd node_modules/appium-ios-remotexpc
 *   sudo HOME="$HOME" node scripts/tunnel-creation.mjs --keep-open
 *
 * Commands:
 *   refresh   idle frame timings, as seen from rAF
 *   hz        refresh rate measured natively, ambient vs boosted (needs the
 *             HighRefreshRate plugin; rAF cannot measure this, being capped itself)
 *   caps      whether this WebKit accepts the linear() easing the release relies on
 *   synth     drive synthetic flicks and report the trajectory
 *             SPIKE_SYNTH_MODE=flick|interrupt, SPIKE_SYNTH_REPS=n
 *   flick     open a capture window and record real finger swipes
 *   slide     programmatic tab-tap slide
 *   probe     one-shot look at the track element and its transform
 *   dom       dump testids and body text, for when the app is on an unexpected screen
 *   setup     create a wallet via the onboarding bypass
 *   unlock    enter the passcode
 *   pages     list what the inspector can see, for when no page shows up
 *
 * Environment: SPIKE_UDID, SPIKE_BUNDLE_ID, SPIKE_IOS_VERSION, SPIKE_FLICK_SECONDS.
 */

const { createRemoteDebugger } = require('appium-remote-debugger');

const UDID = process.env.SPIKE_UDID || '00008150-001565011EA3401C';
const BUNDLE_ID = process.env.SPIKE_BUNDLE_ID || 'com.miden.bread';
const PLATFORM_VERSION = process.env.SPIKE_IOS_VERSION || '26.5';

const SELECT_APP_TIMEOUT = 60_000;
const SELECT_APP_POLL_MS = 1_500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const rd = createRemoteDebugger(
    {
      bundleId: BUNDLE_ID,
      additionalBundleIds: ['*'],
      udid: UDID,
      platformVersion: PLATFORM_VERSION,
      isSafari: false,
      includeSafari: false,
      pageLoadMs: 1_000,
      pageReadyTimeout: 15_000
    },
    true
  );

  await rd.connect();

  let pages = [];
  const started = Date.now();
  while (Date.now() - started < SELECT_APP_TIMEOUT) {
    try {
      pages = await rd.selectApp(null, 3, true);
      if (pages && pages.length > 0) break;
    } catch {
      // selectApp throws while no app has registered with the inspector yet.
    }
    await sleep(SELECT_APP_POLL_MS);
  }
  if (!pages || pages.length === 0) {
    await rd.disconnect();
    throw new Error(
      `No inspectable pages for ${BUNDLE_ID} on ${UDID} within ${SELECT_APP_TIMEOUT}ms. ` +
        `Is the Debug build running, and is the tunnel-creation script still up?`
    );
  }

  const pageId = pages[0].id;
  const dot = pageId.indexOf('.');
  await rd.selectPage(pageId.slice(0, dot), parseInt(pageId.slice(dot + 1), 10));
  return rd;
}

const evaluate = (rd, body) => rd.executeAtom('execute_script', [body, []]);

/**
 * Frame recorder. Records rAF delivery times plus a MessageChannel watchdog:
 * WebKit has no Long Tasks API, so main-thread blocking is inferred from gaps
 * between successive microtask-loop pings. Also counts getBoundingClientRect
 * calls (framer-motion layout projection) and DOM mutations (React commit size)
 * so a stall can be attributed rather than merely observed.
 */
const RECORDER = `
window.__PERF__ = window.__PERF__ || {};
var P = window.__PERF__;
if (P.version !== 8) {
  P.version = 8;
  P.frames = [];
  P.pings = [];
  P.rects = 0;
  P.mutations = 0;
  P.recording = false;
  P.syncBlockMs = null;

  if (!P.patched) {
    P.patched = true;
    var origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (P.recording) P.rects++;
      return origRect.apply(this, arguments);
    };
    var mo = new MutationObserver(function (records) {
      if (P.recording) P.mutations += records.length;
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  P.findTrack = function () {
    var container = document.querySelector('div.touch-pan-y');
    return container ? container.firstElementChild : null;
  };

  P.readX = function (el) {
    if (!el) return null;
    // Computed style first, deliberately. A compositor-driven release owns the
    // transform without touching the inline style, so the inline value goes stale
    // — reading it would report the track as motionless for the whole animation.
    // This costs a forced style recalc per sample; acceptable for a probe, and
    // the reason this harness reports its own overhead alongside the timings.
    var cs = getComputedStyle(el).transform;
    // An untransformed track (x === 0, e.g. the Overview page) reports 'none';
    // that is a real position of 0, not an unreadable value.
    if (cs === 'none') return 0;
    if (cs) {
      var parts = cs.match(/matrix.*\\((.+)\\)/);
      if (parts) {
        var nums = parts[1].split(',').map(parseFloat);
        return nums.length === 6 ? nums[4] : nums[12];
      }
    }
    var t = el.style.transform || '';
    var m = t.match(/translateX\\(([-0-9.]+)px\\)/);
    return m ? parseFloat(m[1]) : null;
  };

  /**
   * Drives a real flick through synthetic pointer events.
   *
   * Framer listens for pointer events on the window, so dispatched events go
   * through the same path a finger does — including its velocity tracking, which
   * is why the moves are spread one per frame rather than fired in a burst.
   *
   * mode 'interrupt' grabs the track again mid-release, which is the case that
   * catches a stale drag origin: the release runs on the compositor, so framer's
   * own idea of the position is behind, and a new gesture that trusts it snaps
   * the track back to where the finger left.
   */
  /**
   * Kicks off a native refresh-rate measurement, optionally with a boost active.
   *
   * The result lands on window.__HZ__ rather than being returned, because the
   * inspector's evaluate does not await promises.
   */
  P.hz = function (withBoost) {
    window.__HZ__ = null;
    var api = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.HighRefreshRate;
    if (!api) {
      window.__HZ__ = { error: 'HighRefreshRate plugin not registered' };
      return 'no-plugin';
    }
    var started = withBoost ? api.boost({ durationMs: 2500 }) : Promise.resolve(null);
    started
      .then(function () { return api.measure({ durationMs: 1500 }); })
      .then(function (r) { window.__HZ__ = r; })
      .catch(function (e) { window.__HZ__ = { error: String((e && e.message) || e) }; });
    return 'started';
  };

  P.synth = function (mode, opts) {
    opts = opts || {};
    var track = P.findTrack();
    if (!track) return 'no-track';

    var y = Math.round(innerHeight * 0.45);
    var cx = Math.round(innerWidth * 0.78);
    // Starting the gesture over a specific element matters: a drag that begins on
    // a text input behaves differently from one on inert content, because WebKit
    // may claim the horizontal gesture for the input's own scroller or selection.
    if (opts.selector) {
      var matches = document.querySelectorAll(opts.selector);
      var el = matches[opts.nth || 0];
      if (!el) return 'no-match:' + opts.selector;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 'zero-rect:' + opts.selector;
      y = Math.round(r.top + r.height / 2);
      cx = Math.round(r.left + r.width / 2);
    }
    var dir = opts.dir === 'right' ? 1 : -1;
    var target = document.elementFromPoint(cx, y) || track;
    P.lastSynthTarget =
      target.tagName.toLowerCase() + (target.getAttribute('data-testid') ? '[' + target.getAttribute('data-testid') + ']' : '');

    function ev(type, clientX, buttons) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: clientX,
          clientY: y,
          screenX: clientX,
          screenY: y,
          buttons: buttons
        })
      );
    }

    var STEP = 28;
    var MOVES = 7;
    var i = 0;
    function frame() {
      if (i === 0) {
        ev('pointerdown', cx, 1);
      } else if (i <= MOVES) {
        cx += STEP * dir;
        ev('pointermove', cx, 1);
      } else {
        ev('pointerup', cx, 0);
        if (mode === 'interrupt') {
          setTimeout(function () {
            ev('pointerdown', cx, 1);
            setTimeout(function () { ev('pointerup', cx, 0); }, 80);
          }, 120);
        }
        return;
      }
      i++;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return 'started';
  };

  P.start = function () {
    P.frames = [];
    P.xs = [];
    P.pings = [];
    P.rects = 0;
    P.mutations = 0;
    P.recording = true;
    // A run that threw before reaching stop() leaves its sampling loop alive, and
    // two loops pushing into the same array double the frame count and halve the
    // median — a 60Hz display then reports as 120Hz, which is precisely the
    // mistake this tool exists to catch. Each run claims a generation, and a loop
    // that no longer owns it retires on its next tick.
    P.generation = (P.generation || 0) + 1;
    var gen = P.generation;

    var track = P.findTrack();
    P.trackFound = !!track;

    var rafStep = function (t) {
      if (!P.recording || gen !== P.generation) return;
      P.frames.push(t);
      P.xs.push(P.readX(track));
      requestAnimationFrame(rafStep);
    };
    requestAnimationFrame(rafStep);

    var mc = new MessageChannel();
    P.port = mc.port2;
    mc.port1.onmessage = function () {
      if (!P.recording || gen !== P.generation) return;
      P.pings.push(performance.now());
      mc.port2.postMessage(0);
    };
    mc.port2.postMessage(0);
  };

  P.stop = function () {
    P.recording = false;
  };

  P.report = function () {
    var deltas = [];
    for (var i = 1; i < P.frames.length; i++) deltas.push(P.frames[i] - P.frames[i - 1]);
    var sorted = deltas.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

    var blocks = [];
    for (var j = 1; j < P.pings.length; j++) {
      var gap = P.pings[j] - P.pings[j - 1];
      if (gap > 8) blocks.push(Math.round(gap * 10) / 10);
    }
    blocks.sort(function (a, b) { return b - a; });

    var budget = median > 12 ? 16.67 : 8.33;
    var dropped = deltas.filter(function (d) { return d > budget * 1.5; });

    // Position trajectory: a hitch shows up as a direction reversal or a stall
    // mid-flight, which leaves frame timings looking perfectly healthy.
    var moves = [];
    for (var k = 1; k < P.xs.length; k++) {
      if (P.xs[k] === null || P.xs[k - 1] === null) continue;
      moves.push({ i: k, t: P.frames[k], dx: P.xs[k] - P.xs[k - 1] });
    }
    var NOISE = 0.4;
    var reversals = [];
    var lastDir = 0;
    for (var q = 0; q < moves.length; q++) {
      var d = moves[q].dx;
      if (Math.abs(d) < NOISE) continue;
      var dir = d > 0 ? 1 : -1;
      if (lastDir !== 0 && dir !== lastDir) {
        reversals.push({
          // Relative to the start of the recording, matching xTrace. These used
          // to be raw performance.now() values while the trace was normalised,
          // which makes a reversal impossible to locate in the trace beside it.
          atMs: Math.round(moves[q].t - P.frames[0]),
          x: Math.round(P.xs[moves[q].i]),
          dxBefore: Math.round(moves[q - 1] ? moves[q - 1].dx * 10 : 0) / 10,
          dxAfter: Math.round(d * 10) / 10
        });
      }
      lastDir = dir;
    }
    // Stalls: |dx| under noise for >=2 consecutive frames while motion is
    // ongoing on both sides (a pause in the middle of a slide).
    //
    // resumeDx is how far the frame that ended the stall travelled, and is the
    // difference between the two things this catches. A hitch mid-flick resumes
    // at flick speed (tens of px); a spring settling on its target resumes at
    // ~1px, having run out of distance rather than been interrupted. Both are
    // reported — deciding which is which is the reader's call, not the probe's.
    var stalls = [];
    var run = 0;
    var sawMotion = false;
    for (var r = 0; r < moves.length; r++) {
      if (Math.abs(moves[r].dx) < NOISE) {
        run++;
      } else {
        // Bookended on both sides, as advertised. Without the leading side the
        // idle frames between starting the recorder and the gesture arriving
        // score as a stall, on every single run — a false positive that reads
        // exactly like the real defect this exists to find.
        if (run >= 2 && sawMotion) {
          stalls.push({
            atMs: Math.round(moves[r].t - P.frames[0]),
            frames: run,
            resumeDx: Math.round(Math.abs(moves[r].dx) * 10) / 10
          });
        }
        run = 0;
        sawMotion = true;
      }
    }
    var absMoves = moves.map(function (m) { return Math.abs(m.dx); });

    return {
      trackFound: P.trackFound,
      reversalCount: reversals.length,
      reversals: reversals.slice(0, 10),
      stallCount: stalls.length,
      stalls: stalls.slice(0, 10),
      peakPxPerFrame: absMoves.length ? Math.round(Math.max.apply(null, absMoves) * 10) / 10 : 0,
      xTrace: (function () {
        var first = -1;
        var last = -1;
        for (var a = 0; a < moves.length; a++) {
          if (Math.abs(moves[a].dx) >= NOISE) {
            if (first === -1) first = moves[a].i;
            last = moves[a].i;
          }
        }
        if (first === -1) return [];
        var out = [];
        for (var b = Math.max(0, first - 2); b <= Math.min(P.xs.length - 1, last + 2); b++) {
          if (P.xs[b] === null) continue;
          out.push([Math.round(P.frames[b] - P.frames[0]), Math.round(P.xs[b])]);
        }
        return out;
      })(),
      frameCount: P.frames.length,
      durationMs: P.frames.length > 1 ? Math.round(P.frames[P.frames.length - 1] - P.frames[0]) : 0,
      medianFrameMs: Math.round(median * 100) / 100,
      impliedHz: median > 0 ? Math.round(1000 / median) : 0,
      worstFrameMs: deltas.length ? Math.round(Math.max.apply(null, deltas) * 10) / 10 : 0,
      droppedFrames: dropped.length,
      droppedDetail: dropped.map(function (d) { return Math.round(d * 10) / 10; }).slice(0, 12),
      blockingGapsMs: blocks.slice(0, 12),
      getBoundingClientRectCalls: P.rects,
      domMutations: P.mutations,
      syncBlockMs: P.syncBlockMs
    };
  };
}
return 'ok';
`;

async function withSession(fn) {
  const rd = await connect();
  try {
    return await fn(rd);
  } finally {
    await rd.disconnect().catch(() => {});
  }
}

async function cmdRefresh() {
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    await evaluate(rd, 'window.__PERF__.start(); return 1;');
    await sleep(2000);
    await evaluate(rd, 'window.__PERF__.stop(); return 1;');
    const report = await evaluate(rd, 'return JSON.stringify(window.__PERF__.report());');
    console.log('\n=== IDLE REFRESH RATE ===');
    console.log(report);
  });
}

async function cmdSlide() {
  return withSession(async rd => {
    await evaluate(rd, RECORDER);

    const route = await evaluate(rd, 'return location.hash || location.pathname;');
    console.log(`starting route: ${route}`);

    // Drive the real user path: click the Send segment in SegmentedActionBar so
    // the measured work includes navigate(), the pane re-render and the
    // layoutId pill animation exactly as a tap would.
    const clicked = await evaluate(
      rd,
      `
      var P = window.__PERF__;
      var btns = Array.prototype.slice.call(document.querySelectorAll('button,[role="tab"],[role="button"]'));
      var target = btns.filter(function (b) {
        var s = (b.textContent || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('aria-label') || '');
        return /send/i.test(s);
      })[0];
      if (!target) return JSON.stringify({ error: 'no send segment found', candidates: btns.length });
      P.start();
      var t0 = performance.now();
      target.click();
      P.syncBlockMs = Math.round((performance.now() - t0) * 100) / 100;
      return JSON.stringify({ ok: true, label: (target.textContent || '').trim(), syncBlockMs: P.syncBlockMs });
      `
    );
    console.log(`click: ${clicked}`);

    await sleep(1500);
    await evaluate(rd, 'window.__PERF__.stop(); return 1;');
    const report = await evaluate(rd, 'return JSON.stringify(window.__PERF__.report());');
    console.log('\n=== PROGRAMMATIC SLIDE (tab tap) ===');
    console.log(report);
    const after = await evaluate(rd, 'return location.hash || location.pathname;');
    console.log(`ending route: ${after}`);
  });
}

async function cmdFlick() {
  const seconds = Number(process.env.SPIKE_FLICK_SECONDS || 8);
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    await evaluate(rd, 'window.__PERF__.start(); return 1;');
    console.log(`\nRecording for ${seconds}s — swipe the home carousel back and forth now, using quick flicks.`);
    await sleep(seconds * 1000);
    await evaluate(rd, 'window.__PERF__.stop(); return 1;');
    const report = await evaluate(rd, 'return JSON.stringify(window.__PERF__.report());');
    console.log('\n=== REAL FINGER FLICKS ===');
    console.log(report);
  });
}

async function pollFor(rd, body, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ok = await evaluate(rd, body);
      if (ok === true || ok === 'true') return true;
    } catch {
      // WebView may be mid-navigation; keep polling.
    }
    await sleep(1000);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * Create a fresh wallet through the Welcome.tsx `__test_skip_onboarding` bypass
 * so the carousel is reachable without hand-driving onboarding on the device.
 */
async function cmdSetup() {
  return withSession(async rd => {
    // Mobile unlock is a 6-digit passcode numpad, so the onboarding password
    // has to be 6 digits or the wallet is unreachable after a relaunch.
    const password = process.env.SPIKE_PASSCODE || '123456';
    await pollFor(
      rd,
      'return !!document.querySelector(\'[data-testid="onboarding-welcome"]\') || (!!window.__TEST_STORE__ && window.__TEST_STORE__.getState().status === 2);',
      60_000,
      'welcome screen or already-ready wallet'
    );

    const already = await evaluate(
      rd,
      'return !!(window.__TEST_STORE__ && window.__TEST_STORE__.getState().status === 2);'
    );
    if (already === true) {
      console.log('wallet already set up — nothing to do');
      return;
    }

    await evaluate(
      rd,
      `var u = new URL(location.href); ` +
        `u.searchParams.set('__test_skip_onboarding', '1'); ` +
        `u.searchParams.set('password', '${encodeURIComponent(password)}'); ` +
        `location.href = u.toString(); return null;`
    );
    await sleep(3000);

    await pollFor(
      rd,
      'return !!document.querySelector(\'[data-testid="onboarding-confirmation"]\');',
      120_000,
      'onboarding confirmation screen'
    );
    await evaluate(
      rd,
      `var b = document.querySelector('[data-testid="onboarding-confirmation-submit"]'); if (b) b.click(); return !!b;`
    );

    await pollFor(
      rd,
      'var s = window.__TEST_STORE__; if (!s) return false; var st = s.getState(); return !!(st && st.status === 2 && st.currentAccount);',
      180_000,
      'wallet Ready with an account'
    );
    const address = await evaluate(
      rd,
      'var s = window.__TEST_STORE__.getState(); return (s.currentAccount && s.currentAccount.publicKey) || "";'
    );
    console.log(`wallet ready: ${address}`);
  });
}

/** Tap through the 6-digit passcode numpad so a relaunch needs no hands. */
async function cmdUnlock() {
  const code = process.env.SPIKE_PASSCODE || '123456';
  return withSession(async rd => {
    const locked = await evaluate(rd, 'return !!document.querySelector(\'[data-testid="unlock-passcode"]\');');
    if (locked !== true) {
      console.log('not on the unlock screen — nothing to do');
      return;
    }
    for (const digit of code.split('')) {
      await evaluate(
        rd,
        `var b = document.querySelector('[data-testid="numpad-${digit}"]'); if (b) b.click(); return !!b;`
      );
      await sleep(150);
    }
    await pollFor(
      rd,
      'var s = window.__TEST_STORE__; if (!s) return false; var st = s.getState(); return !!(st && st.status === 2 && st.currentAccount);',
      60_000,
      'wallet unlocked'
    );
    console.log('unlocked');
  });
}

/** Dump what screen the app is on, for when the expected element is missing. */
async function cmdDom() {
  return withSession(async rd => {
    const out = await evaluate(
      rd,
      `
      var ids = Array.prototype.slice.call(document.querySelectorAll('[data-testid]')).map(function (e) { return e.getAttribute('data-testid'); });
      var store = window.__TEST_STORE__ ? window.__TEST_STORE__.getState() : null;
      return JSON.stringify({
        url: location.href,
        hash: location.hash,
        readyState: document.readyState,
        testIds: ids.slice(0, 40),
        bodyText: (document.body ? (document.body.innerText || '') : '').slice(0, 300),
        hasTestStore: !!window.__TEST_STORE__,
        storeStatus: store ? store.status : null,
        hasAccount: store ? !!store.currentAccount : null
      });
      `
    );
    console.log(out);
  });
}

/** Verify the track element is found and its transform is readable. */
async function cmdProbe() {
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    const out = await evaluate(
      rd,
      `
      var P = window.__PERF__;
      var container = document.querySelector('div.touch-pan-y');
      var track = P.findTrack();
      return JSON.stringify({
        containerFound: !!container,
        containerClass: container ? container.className : null,
        trackFound: !!track,
        trackClass: track ? track.className : null,
        inlineTransform: track ? (track.style.transform || '(empty)') : null,
        computedTransform: track ? getComputedStyle(track).transform : null,
        readX: track ? P.readX(track) : null,
        route: location.hash
      });
      `
    );
    console.log(out);
  });
}

/**
 * Report the refresh rate the app is actually served, measured natively.
 *
 * `rAF` cannot answer this: WebKit caps it at 60Hz inside WKWebView, so it can
 * never observe a rate faster than itself. Runs the measurement with and without
 * a boost so the boost's effect is visible rather than assumed.
 */
async function cmdHz() {
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    for (const withBoost of [false, true]) {
      const started = await evaluate(rd, `return window.__PERF__.hz(${withBoost});`);
      if (started !== 'started') {
        console.log(`boost=${withBoost}: ${started}`);
        continue;
      }
      await sleep(2600);
      const out = await evaluate(rd, 'return JSON.stringify(window.__HZ__);');
      console.log(`boost=${withBoost}: ${out}`);
    }
  });
}

/**
 * Run synthetic flicks and report the resulting trajectory.
 *
 * Removes the human from the loop: a real finger can't be asked to reproduce a
 * mid-release grab on cue, and eyeballing a 16ms stall isn't reliable anyway.
 */
async function cmdSynth() {
  const mode = process.env.SPIKE_SYNTH_MODE || 'flick';
  const reps = Number(process.env.SPIKE_SYNTH_REPS || 6);
  const opts = {
    selector: process.env.SPIKE_SYNTH_SELECTOR || undefined,
    nth: process.env.SPIKE_SYNTH_NTH ? Number(process.env.SPIKE_SYNTH_NTH) : undefined,
    dir: process.env.SPIKE_SYNTH_DIR || 'left'
  };
  const startRoute = process.env.SPIKE_SYNTH_ROUTE || '#/';
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    // Park on a known page so every run starts from the same place. Without this,
    // a previous run leaves the carousel wherever it ended and a flick becomes a
    // rubber-band snap-back instead of a page commit — which looks like a pass
    // while testing nothing.
    await evaluate(rd, `location.hash = ${JSON.stringify(startRoute)}; return 1;`);
    await sleep(1200);
    const route = await evaluate(rd, 'return location.hash;');
    await evaluate(rd, 'window.__PERF__.start(); return 1;');
    for (let i = 0; i < reps; i++) {
      const started = await evaluate(
        rd,
        `return window.__PERF__.synth(${JSON.stringify(mode)}, ${JSON.stringify(opts)});`
      );
      if (started !== 'started') throw new Error(`synth failed to start: ${started}`);
      await sleep(1400);
    }
    await evaluate(rd, 'window.__PERF__.stop(); return 1;');
    const hitTarget = await evaluate(rd, 'return window.__PERF__.lastSynthTarget || null;');
    const report = await evaluate(rd, 'return JSON.stringify(window.__PERF__.report());');
    console.log(
      `\n=== SYNTHETIC ${mode.toUpperCase()} x${reps} dir=${opts.dir} route=${route}` +
        `${opts.selector ? ` over ${opts.selector}[${opts.nth || 0}] -> hit ${hitTarget}` : ''} ===`
    );
    console.log(report);
  });
}

/**
 * Check the animation capabilities the compositor release depends on.
 *
 * A `linear()` easing that this WebKit rejects makes `element.animate()` throw,
 * which would leave the release doing nothing at all rather than failing loudly.
 */
async function cmdCaps() {
  return withSession(async rd => {
    const out = await evaluate(
      rd,
      `
      var result = { linearSupported: null, animateAccepts: null, error: null, composited: null };
      try {
        result.linearSupported = CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)');
        var probe = document.createElement('div');
        document.body.appendChild(probe);
        var anim = probe.animate(
          [{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }],
          { duration: 300, easing: 'linear(0,0.2,0.6,0.9,1)', fill: 'forwards' }
        );
        result.animateAccepts = true;
        result.composited = typeof anim.currentTime === 'number' || anim.currentTime === 0;
        anim.cancel();
        probe.remove();
      } catch (e) {
        result.animateAccepts = false;
        result.error = String(e && e.message ? e.message : e);
      }
      return JSON.stringify(result);
      `
    );
    console.log(out);
  });
}

/**
 * Runs a snippet from a file in the page, for one-off diagnostics that don't
 * warrant a command of their own.
 *
 * The snippet may be asynchronous: whatever it leaves on `window.__DIAG__` is
 * read back after `SPIKE_EVAL_WAIT` ms, so it can instrument a gesture and
 * report once the gesture has played out.
 */
async function cmdEval() {
  const file = process.env.SPIKE_EVAL_FILE;
  if (!file) throw new Error('set SPIKE_EVAL_FILE=<path> to a file containing the snippet body');
  const body = require('fs').readFileSync(file, 'utf8');
  const wait = Number(process.env.SPIKE_EVAL_WAIT || 2000);
  return withSession(async rd => {
    await evaluate(rd, RECORDER);
    const immediate = await evaluate(rd, body);
    if (immediate != null) console.log(`returned: ${immediate}`);
    await sleep(wait);
    console.log(await evaluate(rd, 'return JSON.stringify(window.__DIAG__ || null, null, 1);'));
  });
}

/** Dump what the inspector can see, for when no pages show up. */
async function cmdPages() {
  const rd = createRemoteDebugger(
    {
      bundleId: BUNDLE_ID,
      additionalBundleIds: ['*'],
      udid: UDID,
      platformVersion: PLATFORM_VERSION,
      isSafari: false,
      includeSafari: false,
      pageLoadMs: 1_000,
      pageReadyTimeout: 15_000
    },
    true
  );
  await rd.connect();
  for (let attempt = 1; attempt <= 5; attempt++) {
    let pages;
    let err;
    try {
      pages = await rd.selectApp(null, 3, true);
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
    const apps = rd.appDict || {};
    console.log(
      `attempt ${attempt}: pages=${JSON.stringify(pages || null)} err=${err || 'none'} ` +
        `appKeys=${JSON.stringify(Object.keys(apps))}`
    );
    for (const [key, app] of Object.entries(apps)) {
      console.log(
        `  app ${key}: bundleId=${app.bundleId} name=${app.name} pages=${JSON.stringify(app.pageArray || [])}`
      );
    }
    await sleep(2000);
  }
  await rd.disconnect().catch(() => {});
}

const CMDS = {
  refresh: cmdRefresh,
  slide: cmdSlide,
  flick: cmdFlick,
  pages: cmdPages,
  setup: cmdSetup,
  probe: cmdProbe,
  dom: cmdDom,
  unlock: cmdUnlock,
  caps: cmdCaps,
  synth: cmdSynth,
  hz: cmdHz,
  eval: cmdEval
};

(async () => {
  const cmd = process.argv[2] || 'refresh';
  const fn = CMDS[cmd];
  if (!fn) {
    console.error(`unknown command "${cmd}" — expected one of: ${Object.keys(CMDS).join(', ')}`);
    process.exit(1);
  }
  try {
    await fn();
    process.exit(0);
  } catch (err) {
    console.error(`\nFAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
})();
