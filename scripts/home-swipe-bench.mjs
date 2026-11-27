#!/usr/bin/env node
/**
 * Headless Chrome benchmark for the Home panes: the swipe, where the panes
 * still page on one, and the tab taps.
 *
 * This is a proxy for a thumb, not a phone. It opens the mobile bundle, creates
 * a mock wallet once, and drives the real panes with CDP touches on a steady
 * clock. A swipe pass swipes from Overview through to Swap; a tap pass taps the
 * Home tabs from Overview through to Swap and jumps back. The default run is six
 * passes of each. The main thread is slowed (`--throttle`, default 4) so a
 * fast laptop shows the stalls a phone would. The scores live in
 * `home-swipe-score.mjs`: the panes have to land on the target and move without
 * stalling. A smooth frame trace that does not move still counts as a miss.
 *
 * A side whose panes do not page on a swipe records no swipe samples. It says
 * so after proving it: one sideways drag before the passes, and one on another
 * pane in every tap pass, must move no pane and change no route.
 *
 * Loop:
 *   node scripts/home-swipe-bench.mjs --label baseline --rebuild
 *   # change one thing in the swipe path
 *   node scripts/home-swipe-bench.mjs --label <idea> --rebuild
 *   node scripts/home-swipe-bench.mjs --compare baseline <idea>
 * Keep the change only when compare calls it a winner.
 *
 * It serves the production mobile bundle from `dist/mobile`. The vite dev
 * server cannot host this app: the SVG plugin only emits files at build time.
 * Pass `--rebuild` after a source change so the next label measures the new
 * bundle. Profile and traces stay in `.bench/`.
 */

import { execSync } from 'node:child_process';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import {
  analyzeSwipe,
  analyzeTap,
  frameHealth,
  HOME_PATHS,
  homePath,
  judge,
  median,
  summarize,
  summarizeTaps,
  TAP_PATH
} from './home-swipe-score.mjs';

const INP_TAPS = 6;
const TAB_INP_TAPS = 6;
const HOME_IDS = ['overview', 'send', 'receive', 'earn', 'swap'];
const TAP_CAPTURE_MS = 900;
const INTERRUPT_AFTER_MS = 120;
const SWIPE_REMOVED = 'verified: 0px travel, route unchanged';
const LIST_RUNS = 3;
const COPY_ADDRESS = '[data-testid="balance-card-copy-address"]';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_DIR = resolve(ROOT, '.bench');
const DIST = resolve(ROOT, 'dist/mobile');
const PORT = 4179;
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const PASSCODE = '123456';
const RESULTS = resolve(BENCH_DIR, 'results.jsonl');

const RECORDER = `
(() => {
  const P = (window.__PERF__ = window.__PERF__ || {});
  if (P.version === 1) return 'ok';
  P.version = 1;
  P.frames = [];
  P.xs = [];
  P.pings = [];
  P.loafs = [];
  P.input = [];
  P.rects = 0;
  P.mutations = 0;
  P.pointers = { down: 0, move: 0, touch: 0 };
  P.recording = false;
  if (!P.listening) {
    P.listening = true;
    const count = event => {
      if (!P.recording) return;
      if (event.type === 'pointerdown') P.pointers.down += 1;
      if (event.type === 'pointermove') P.pointers.move += 1;
      if (event.type === 'touchmove') P.pointers.touch += 1;
    };
    window.addEventListener('pointerdown', count, true);
    window.addEventListener('pointermove', count, true);
    window.addEventListener('touchmove', count, true);
  }

  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (P.recording) P.rects += 1;
    return orig.apply(this, arguments);
  };
  const mo = new MutationObserver(records => {
    if (P.recording) P.mutations += records.length;
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  try {
    new PerformanceObserver(list => {
      if (!P.recording) return;
      for (const entry of list.getEntries()) {
        P.loafs.push({
          duration: Math.round(entry.duration),
          blocking: Math.round(entry.blockingDuration || 0),
          scripts: (entry.scripts || []).slice(0, 4).map(script => ({
            fn: script.invoker || script.name || '',
            file: script.sourceURL ? script.sourceURL.split('/').pop() : '',
            duration: Math.round(script.duration || 0)
          }))
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* older Chrome */ }
  try {
    new PerformanceObserver(list => {
      if (!P.recording) return;
      for (const entry of list.getEntries()) {
        P.input.push({
          name: entry.name,
          startTime: entry.startTime,
          delay: entry.processingStart - entry.startTime,
          duration: entry.duration
        });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  } catch { /* event timing missing */ }

  // The workflow runs this harness on base too. A base with the scroll-snap
  // pager is read through it; a side without one has no pager at all.
  P.findPager = () => {
    const scroller = document.querySelector('[data-home-pager]');
    return scroller ? { container: scroller, track: scroller.querySelector('[data-home-track]') } : null;
  };
  P.pane = id => document.querySelector('[data-home-page="' + id + '"]');
  P.tabPane = () => P.pane('overview')?.closest('[data-tab-pane]') ?? null;
  // What is drawn: the rect through the unpatched getter, so the rects counter
  // stays the page's own, and the opacity of the pane and every ancestor up to
  // its tab pane. A pane hidden by visibility draws nothing.
  P.paneState = id => {
    const el = P.pane(id);
    if (!el) return null;
    const rect = orig.call(el);
    let opacity = 1;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) opacity = 0;
    else {
      const stop = el.closest('[data-tab-pane]');
      for (let node = el; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
        if (node === stop) break;
      }
    }
    return { left: rect.left, width: rect.width, opacity };
  };
  P.tabBox = () => {
    const tab = P.tabPane();
    if (!tab) return null;
    const rect = orig.call(tab);
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  P.allPanes = () => [...document.querySelectorAll('[data-home-page]')].map(el => ({
    id: el.getAttribute('data-home-page'),
    ...P.paneState(el.getAttribute('data-home-page'))
  }));
  const running = el => !!el && el.getAnimations().some(animation => animation.playState === 'running');
  /** The end state of a switch: the target alone drawn and live, nothing still moving. */
  P.landed = id => {
    const tab = P.tabBox();
    const target = P.pane(id);
    if (!tab || !target) return false;
    const state = P.paneState(id);
    if (state.opacity < 0.99 || target.closest('[inert]') || Math.abs(state.left - tab.left) > 2) return false;
    for (const el of document.querySelectorAll('[data-home-page]')) {
      if (running(el)) return false;
      if (el.style.pointerEvents === 'none' || el.style.willChange) return false;
      if (el === target) continue;
      if (!el.closest('[inert]') && P.paneState(el.getAttribute('data-home-page')).opacity > 0) return false;
    }
    return !running(document.querySelector('[data-home-track]'));
  };
  P.tabRect = index => {
    const tabs = document.querySelectorAll('[data-home-actions] [role="tab"]');
    const tab = tabs[index];
    if (!tab || tabs.length !== 5) return null;
    const rect = orig.call(tab);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, count: tabs.length };
  };
  P.findTrack = () => P.findPager()?.track ?? null;
  P.readX = pager => {
    if (!pager || !pager.track) return null;
    const transform = getComputedStyle(pager.track).transform;
    const x = !transform || transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
    // The pager moves by scrolling. Its track only carries the short transform
    // of a programmatic flip, so the two add up to what is painted.
    return x - pager.container.scrollLeft;
  };
  P.hit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid'),
      className: String(el.className || '').slice(0, 80)
    };
  };
  P.start = panes => {
    P.frames = [];
    P.xs = [];
    P.panes = panes || null;
    P.paneFrames = [];
    P.pings = [];
    P.loafs = [];
    P.input = [];
    P.rects = 0;
    P.mutations = 0;
    P.pointers = { down: 0, move: 0, touch: 0 };
    P.recording = true;
    P.generation = (P.generation || 0) + 1;
    const gen = P.generation;
    const pager = P.findPager();
    P.trackFound = !!pager?.track;
    // Read the position from a task posted during the frame, so it runs after
    // that frame's microtasks and paint. Reading inside the animation frame
    // itself sees the transform framer clears for a layout measurement and
    // restores before anything is painted, and reports a jump the thumb never saw.
    const paint = new MessageChannel();
    let pending = null;
    paint.port1.onmessage = () => {
      if (!P.recording || gen !== P.generation || pending == null) return;
      const t = pending;
      pending = null;
      P.frames.push(t);
      P.xs.push(P.readX(pager));
      if (P.panes) P.paneFrames.push(P.panes.map(id => P.paneState(id)));
    };
    const step = t => {
      if (!P.recording || gen !== P.generation) return;
      pending = t;
      paint.port2.postMessage(0);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (!P.recording || gen !== P.generation) return;
      P.pings.push(performance.now());
      // Paced. A tight postMessage loop would itself saturate the main thread
      // and the benchmark would be measuring the probe.
      setTimeout(() => channel.port2.postMessage(0), 5);
    };
    channel.port2.postMessage(0);
  };
  P.stop = () => {
    P.recording = false;
    const container = P.findPager()?.container;
    return {
      frames: P.frames,
      xs: P.xs,
      paneFrames: P.paneFrames,
      pings: P.pings,
      loafs: P.loafs,
      input: P.input,
      rects: P.rects,
      mutations: P.mutations,
      pointers: P.pointers,
      trackFound: P.trackFound,
      route: location.hash,
      pageWidth: container ? container.clientWidth : 0
    };
  };
  return 'ok';
})()
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    label: 'baseline',
    throttle: 4,
    reps: 6,
    dpr: 2,
    compare: null,
    rebuild: false,
    summary: null
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--label') args.label = argv[++i];
    else if (token === '--throttle') args.throttle = Number(argv[++i]);
    else if (token === '--reps') args.reps = Number(argv[++i]);
    else if (token === '--dpr') args.dpr = Number(argv[++i]);
    else if (token === '--rebuild') args.rebuild = true;
    else if (token === '--summary') args.summary = argv[++i];
    else if (token === '--compare') args.compare = [argv[++i], argv[++i]];
    else if (token === '--help') args.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

function gitStamp() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: true };
  }
}

function readResults() {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function latest(label) {
  const rows = readResults().filter(row => row.label === label);
  return rows[rows.length - 1] ?? null;
}

function printCompare(leftLabel, rightLabel) {
  const left = latest(leftLabel);
  const right = latest(rightLabel);
  if (!left || !right) {
    throw new Error(`missing a run for ${left ? rightLabel : leftLabel}`);
  }
  const verdict = judge(left.summary, right.summary);
  console.log(
    `${leftLabel}  feel ${left.summary.medianFeel}  follow ${left.summary.medianFollowP95Px}px  worst ${left.summary.medianWorstFrameMs}ms  commits ${left.summary.commits}/${left.summary.swipes}`
  );
  console.log(
    `${rightLabel}  feel ${right.summary.medianFeel}  follow ${right.summary.medianFollowP95Px}px  worst ${right.summary.medianWorstFrameMs}ms  commits ${right.summary.commits}/${right.summary.swipes}`
  );
  console.log(verdict.winner ? `winner: ${rightLabel} (${verdict.reason})` : `not a winner (${verdict.reason})`);
  return verdict.winner ? 0 : 2;
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

const FILE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function rebuildBundle() {
  console.log('building the mobile bundle');
  // vite directly, not `yarn build:mobile`: that script's prebuild runs
  // `yarn check --integrity`, which fails when the install was made on another
  // machine and would block the loop before any swipe is measured.
  execSync('yarn vite build --config vite.mobile.config.ts', {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MODE_ENV: 'production',
      MIDEN_E2E_TEST: 'true',
      MIDEN_USE_MOCK_CLIENT: 'true',
      MIDEN_E2E_DISABLE_SIDEPANEL: 'true'
    },
    stdio: 'inherit'
  });
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', PAGE_URL);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = normalize(join(DIST, pathname));
      if (file !== DIST && !file.startsWith(DIST + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let stat;
      try {
        stat = statSync(file);
      } catch {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': FILE_TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      createReadStream(file)
        .on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        })
        .pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

async function ensureServer() {
  mkdirSync(BENCH_DIR, { recursive: true });
  if (await portOpen(PORT)) {
    const res = await fetch(PAGE_URL, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (text.includes('/src/mobile-app.tsx')) {
      throw new Error(`port ${PORT} is still the vite dev server. Stop it and re-run.`);
    }
    if (!res.ok) throw new Error(`port ${PORT} is open but ${PAGE_URL} returned ${res.status}`);
    return;
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/mobile/index.html is missing. Re-run with --rebuild.');
  }
  await startStaticServer();
  console.log(`serving ${DIST} at ${PAGE_URL}`);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const store = window.__TEST_STORE__?.getState?.();
    return {
      status: store ? store.status : null,
      hasAccount: !!(store && store.currentAccount),
      welcome: !!document.querySelector('[data-testid="onboarding-welcome"]'),
      confirm: !!document.querySelector('[data-testid="onboarding-confirmation"]'),
      unlock: !!document.querySelector('[data-testid="unlock-passcode"]'),
      panes: !!document.querySelector('[data-home-page]'),
      hash: location.hash,
      text: (document.body?.innerText || '').slice(0, 180)
    };
  });
}

async function reachHome(page) {
  page.setDefaultTimeout(180_000);
  // Import the public mock fixture: a carousel measurement does not create a mainnet account.
  await page.addInitScript(() => {
    globalThis.__TEST_IMPORT_SEED__ = 'abandon '.repeat(11) + 'about';
  });
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const deadline = Date.now() + 240_000;
  let bypassed = false;
  let submitted = false;
  let unlocked = false;
  let declinedTelemetry = false;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (Date.now() - lastLog > 15_000) {
      console.log(
        `waiting for home: status=${snap.status} welcome=${snap.welcome} confirm=${snap.confirm} unlock=${snap.unlock} panes=${snap.panes}`
      );
      lastLog = Date.now();
    }
    if (snap.panes && snap.status === 2) {
      console.log(`home ready ${snap.hash || '(no hash)'}`);
      return snap;
    }
    if (snap.unlock && !unlocked) {
      console.log('unlocking');
      for (const digit of PASSCODE) {
        await page.locator(`[data-testid="numpad-${digit}"]`).click();
        await sleep(80);
      }
      unlocked = true;
      continue;
    }
    if (snap.hash.includes('help-improve-wallet') && !declinedTelemetry) {
      console.log('declining telemetry');
      await page.locator('[data-testid="help-improve-wallet-decline"]').click();
      declinedTelemetry = true;
      continue;
    }
    if (snap.confirm && !submitted) {
      console.log('confirming wallet');
      await page.locator('[data-testid="onboarding-confirmation-submit"]').click();
      submitted = true;
      continue;
    }
    if (snap.welcome && !bypassed) {
      console.log('creating a mock wallet');
      const url = new URL(PAGE_URL);
      url.searchParams.set('__test_skip_onboarding', '1');
      url.searchParams.set('password', PASSCODE);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 180_000 });
      bypassed = true;
      continue;
    }
    await sleep(500);
  }
  throw new Error(`home not reached: ${JSON.stringify(await snapshot(page))}`);
}

/** Maps the runner's clock onto the page's. The midpoint splits the round trip. */
async function pageClockOffset(page) {
  const sent = performance.now();
  const pageNow = await page.evaluate(() => performance.now());
  return pageNow - (sent + performance.now()) / 2;
}

async function dispatchTouch(cdp, offset, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  // CDP answers once the renderer has acked the event, so this is the same
  // after-the-handler stamp the pointer path takes, on the page's clock.
  return performance.now() + offset;
}

/** A native scroller ignores synthetic pointer events, so the swipe is made of real touches. */
async function driveSwipe(page, cdp, box) {
  const y = Math.round(box.top + box.height * 0.78);
  const x0 = Math.round(box.left + box.width * 0.8);
  const x1 = Math.round(box.left + box.width * 0.22);
  const durationMs = 240;
  const stepMs = 8;
  const steps = Math.round(durationMs / stepMs);
  const events = [];
  const offset = await pageClockOffset(page);
  const send = (phase, x) =>
    dispatchTouch(cdp, offset, { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[phase], x, y);

  events.push({ t: await send('down', x0), x: x0, type: 'down' });

  let next = performance.now() + stepMs;
  for (let i = 1; i <= steps; i++) {
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    events.push({ t: await send('move', x), x, type: 'move' });
    next += stepMs;
  }

  events.push({ t: await send('up', x1), x: x1, type: 'up' });
  return { events, point: { x: x0, y } };
}

/** Waits until the route is the page and the page alone is drawn, whatever moves the panes. */
async function settlePage(page, index) {
  const path = HOME_PATHS[index];
  if (index === 0) {
    await page.evaluate(() => {
      if (location.hash !== '#/' && location.hash !== '#' && location.hash !== '') location.hash = '#/';
    });
  }
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(
      id => ({ hash: location.hash, landed: window.__PERF__.landed(id), panes: window.__PERF__.allPanes() }),
      HOME_IDS[index]
    );
    if (homePath(last.hash) === path && last.landed) return last;
    await sleep(40);
  }
  throw new Error(`${path} did not settle: ${JSON.stringify(last)}`);
}

/** A trusted tap on the Home tab at `index`, at its live centre. Returns touchEnd on the page clock. */
async function tapTab(page, cdp, index) {
  const point = await page.evaluate(i => window.__PERF__.tabRect(i), index);
  if (!point) throw new Error(`Home tab ${index} is missing`);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const offset = await pageClockOffset(page);
  await dispatchTouch(cdp, offset, 'touchStart', x, y);
  await sleep(50);
  return dispatchTouch(cdp, offset, 'touchEnd', x, y);
}

/** Every pane's drawn state, the route and the page's own scroll, for the swipe probe and guard. */
async function homeState(page) {
  return page.evaluate(() => ({ hash: location.hash, panes: window.__PERF__.allPanes(), scrollX: window.scrollX }));
}

function unchanged(before, after) {
  if (homePath(before.hash) !== homePath(after.hash) || after.scrollX !== 0) return false;
  return before.panes.every((pane, i) => {
    const next = after.panes[i];
    return (
      next &&
      next.id === pane.id &&
      Math.abs(next.left - pane.left) <= 1 &&
      Math.abs(next.width - pane.width) <= 1 &&
      Math.abs(next.opacity - pane.opacity) <= 0.01
    );
  });
}

/** The swipe drag on the pane at `index`, then the same wait a scored swipe gets. */
async function probeSwipe(page, cdp, index) {
  const box = await page.evaluate(id => {
    const el = window.__PERF__.pane(id);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, HOME_IDS[index]);
  if (!box || box.width < 50) throw new Error(`${HOME_IDS[index]} pane has no size: ${JSON.stringify(box)}`);
  const before = await homeState(page);
  await driveSwipe(page, cdp, box);
  await sleep(900);
  return { before, after: await homeState(page) };
}

/** Slowest Event Timing entry of each unthrottled tap between Overview and Send. */
async function measureTabInp(page, cdp) {
  const samples = [];
  for (let tap = 0; tap < TAB_INP_TAPS; tap++) {
    const target = tap % 2 === 0 ? 1 : 0;
    await page.evaluate(() => window.__PERF__.start());
    const t0 = await tapTab(page, cdp, target);
    await sleep(300);
    const raw = await page.evaluate(() => window.__PERF__.stop());
    const durations = (raw.input || [])
      .filter(entry => Number.isFinite(entry.duration) && entry.startTime >= t0 - 400 && entry.startTime <= t0 + 300)
      .map(entry => entry.duration);
    const duration = durations.length ? Math.max(...durations) : 16;
    samples.push(duration);
    console.log(`tab tap ${tap + 1}/${TAB_INP_TAPS}  ${duration.toFixed(0)}ms`);
    await settlePage(page, target);
  }
  return samples;
}

async function measureInp(page) {
  const present = await page.locator(COPY_ADDRESS).count();
  if (!present) throw new Error('overview copy control is missing');
  const samples = [];
  for (let tap = 0; tap < INP_TAPS; tap++) {
    await page.evaluate(() => window.__PERF__.start());
    await page.locator(COPY_ADDRESS).click({ timeout: 5000 });
    await sleep(200);
    const raw = await page.evaluate(() => window.__PERF__.stop());
    const durations = (raw.input || []).map(entry => entry.duration).filter(value => Number.isFinite(value));
    // Event Timing drops anything under 16ms. A missing entry is that fast, so
    // record the floor rather than fail a tap the API cannot see.
    const duration = durations.length ? Math.max(...durations) : 16;
    samples.push(duration);
    console.log(`tap ${tap + 1}/${INP_TAPS}  ${duration.toFixed(0)}ms`);
  }
  return samples;
}

async function touchDrag(cdp, x, y0, y1) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await sleep(16);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function profileListBox(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="profile-scroll"]');
    if (!el) return null;
    el.scrollTop = 0;
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      overflow: el.scrollHeight - el.clientHeight,
      scrollTop: el.scrollTop
    };
  });
}

async function measureList(page, cdp) {
  // A fresh mock wallet's overview fits in the frame, so it has nothing to
  // scroll. Profile has a list of settings rows that is taller than the screen.
  await page.evaluate(() => {
    location.hash = '#/me';
  });
  const deadline = Date.now() + 8000;
  let opened = null;
  while (Date.now() < deadline) {
    opened = await profileListBox(page);
    if (opened && opened.overflow >= 80 && opened.height > 50) break;
    opened = null;
    await sleep(40);
  }
  if (!opened) throw new Error(`profile list did not become scrollable: ${JSON.stringify(await profileListBox(page))}`);

  const dropped = [];
  const p95 = [];
  for (let run = 0; run < LIST_RUNS; run++) {
    const before = await profileListBox(page);
    if (!before) throw new Error('profile list is missing');
    if (before.overflow < 80) throw new Error(`profile list does not scroll (${before.overflow}px)`);
    await sleep(50);
    await page.evaluate(() => window.__PERF__.start());
    const x = Math.round(before.left + before.width * 0.5);
    const y0 = Math.round(before.top + before.height * 0.72);
    const y1 = Math.round(before.top + before.height * 0.28);
    await touchDrag(cdp, x, y0, y1);
    await sleep(300);
    const after = await page.evaluate(() => {
      const raw = window.__PERF__.stop();
      const el = document.querySelector('[data-testid="profile-scroll"]');
      return { frames: raw.frames, scrollTop: el ? el.scrollTop : 0 };
    });
    const travel = after.scrollTop - before.scrollTop;
    if (travel < 40) throw new Error(`profile list moved ${travel}px on run ${run + 1}`);
    const health = frameHealth(after.frames);
    if (!health) throw new Error(`profile list produced too few frames on run ${run + 1}`);
    dropped.push(health.droppedPct);
    p95.push(health.p95Ms);
    console.log(
      `list ${run + 1}/${LIST_RUNS}  dropped ${health.droppedPct}%  p95 ${health.p95Ms}ms  travel ${travel}px`
    );
  }
  return { dropped, p95 };
}

function loafLeaders(swipes) {
  const totals = new Map();
  for (const swipe of swipes) {
    for (const loaf of swipe.loafs || []) {
      const scripts = loaf.scripts?.length
        ? loaf.scripts
        : [{ fn: '(unattributed)', file: '', duration: loaf.duration }];
      for (const script of scripts) {
        const key = [script.fn, script.file].filter(Boolean).join(' ');
        totals.set(key, (totals.get(key) || 0) + (script.duration || 0));
      }
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, ms]) => ({ name, ms }));
}

function printReport(record) {
  console.log('');
  console.log(
    `ui smoothness  label=${record.label}  throttle=${record.throttle}  dpr=${record.dpr}  ${record.sha}${record.dirty ? ' dirty' : ''}`
  );
  console.log(
    `idle frame median ${record.idleMedianFrameMs}ms   viewport ${record.viewport.width}x${record.viewport.height}   page ${record.pageWidth}px`
  );
  console.log('rep  feel   follow  worst  drop  hitch  release  travel  rects  commits');
  record.swipes.forEach((swipe, index) => {
    const cols = [
      String(index + 1).padStart(3),
      swipe.feel.toFixed(1).padStart(6),
      `${swipe.followP95Px ?? '-'}`.padStart(6),
      swipe.worstFrameMs.toFixed(0).padStart(6),
      String(swipe.droppedFrames).padStart(5),
      String(swipe.hitchFrames).padStart(6),
      swipe.releaseGapMs.toFixed(0).padStart(8),
      String(swipe.travelPx).padStart(7),
      String(swipe.rects).padStart(6),
      swipe.committed ? '  yes' : '  no'
    ];
    console.log(cols.join(' '));
  });
  const summary = record.summary;
  console.log(
    `median feel ${summary.medianFeel}   follow ${summary.medianFollowP95Px}px   worst ${summary.medianWorstFrameMs}ms   commits ${summary.commits}/${summary.swipes}   reversals ${summary.reversals}`
  );
  if (record.hit) console.log(`finger landed on <${record.hit.tag}> ${record.hit.testid || record.hit.className}`);
  const sample = record.swipes[0];
  if (record.trace?.length) console.log(`trace ${JSON.stringify(record.trace)}`);
  if (sample?.stalls?.length) console.log(`stalls ${JSON.stringify(sample.stalls)}`);
  if (sample?.reversalList?.length) console.log(`reversals ${JSON.stringify(sample.reversalList)}`);
  if (record.loafs.length) {
    console.log('long frames:');
    for (const loaf of record.loafs) console.log(`  ${loaf.ms}ms  ${loaf.name}`);
  }
  console.log('');
}

async function measure(args) {
  await ensureServer();
  mkdirSync(BENCH_DIR, { recursive: true });
  const browserName = process.env.BENCH_BROWSER || 'chrome';
  const profileDir = resolve(BENCH_DIR, process.env.BENCH_PROFILE || 'chrome-profile');
  const launchOptions = {
    headless: true,
    viewport: { width: 600, height: 844 },
    deviceScaleFactor: args.dpr,
    hasTouch: true,
    isMobile: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ]
  };
  // `chromium` is Playwright's own browser. Any other name is a Chrome channel,
  // which is what a laptop with Chrome installed uses.
  if (browserName !== 'chromium') launchOptions.channel = browserName;
  const context = await chromium.launchPersistentContext(profileDir, launchOptions);
  const page = context.pages()[0] || (await context.newPage());
  // The mobile bundle decides it is a phone from Capacitor's platform. In a
  // desktop Chrome that is "web", the frontend then talks to an extension port
  // and the home screen never leaves its loading spinner. Naming the platform
  // before any script runs makes this the same binary the phone runs.
  await context.addInitScript(() => {
    window.CapacitorCustomPlatform = { name: 'ios' };
  });
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(String(error)));

  try {
    await reachHome(page);
    await page.evaluate(source => {
      // The recorder is a page-side probe, passed in as text so the runner
      // stays free of the sampling logic.
      const installed = (0, eval)(source);
      if (installed !== 'ok') throw new Error(`recorder install returned ${installed}`);
    }, RECORDER);
    const pageIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-home-page]')].map(node => node.getAttribute('data-home-page'))
    );
    const expectedIds = ['overview', 'send', 'receive', 'earn', 'swap'];
    if (pageIds.join(',') !== expectedIds.join(',')) {
      throw new Error(`home pages are ${pageIds.join(', ') || '(none)'}; the bench walks ${expectedIds.join(', ')}`);
    }
    await settlePage(page, 0);

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.throttle });
    await page.evaluate(() => window.__PERF__.start());
    await sleep(500);
    const idle = await page.evaluate(() => window.__PERF__.stop());
    const idleDeltas = [];
    for (let i = 1; i < idle.frames.length; i++) idleDeltas.push(idle.frames[i] - idle.frames[i - 1]);
    const idleMedianFrameMs = Math.round(median(idleDeltas) * 10) / 10;
    if (idleMedianFrameMs > 22) {
      console.log(
        `idle frames already ${idleMedianFrameMs}ms at throttle ${args.throttle}; the swipe will be hard to tell apart from the throttle itself`
      );
    }

    const box = await page.evaluate(() => {
      const rect = window.__PERF__.pane('overview').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    if (!box || box.width < 50) throw new Error(`overview pane has no size: ${JSON.stringify(box)}`);
    const hit = await page.evaluate(({ x, y }) => window.__PERF__.hit(x, y), {
      x: Math.round(box.left + box.width * 0.8),
      y: Math.round(box.top + box.height * 0.78)
    });

    // One drag decides which side this is. A pager pages on it; panes without
    // one must not move at all, and anything in between is a broken run.
    const hasPager = await page.evaluate(() => !!window.__PERF__.findPager());
    const probe = await probeSwipe(page, cdp, 0);
    const paged = homePath(probe.after.hash) === HOME_PATHS[1];
    let swipeRemoved = null;
    if (!hasPager && unchanged(probe.before, probe.after)) swipeRemoved = SWIPE_REMOVED;
    else if (!hasPager || !paged) {
      throw new Error(`the swipe probe neither paged nor left the panes alone: ${JSON.stringify(probe)}`);
    }
    console.log(swipeRemoved ? `no swipe: ${swipeRemoved}` : 'pager: native scroll-snap, CDP touches');

    const swipeOnce = async () => {
      const routeBefore = await page.evaluate(() => location.hash);
      await page.evaluate(() => window.__PERF__.start());
      await sleep(50);
      const finger = await driveSwipe(page, cdp, box);
      await sleep(900);
      const raw = await page.evaluate(() => window.__PERF__.stop());
      if (!raw.trackFound) throw new Error('carousel track was not on the page');
      const metrics = analyzeSwipe({
        frames: raw.frames,
        xs: raw.xs,
        pings: raw.pings,
        finger: finger.events,
        inputDelays: (raw.input || []).map(entry => entry.delay),
        routeBefore,
        routeAfter: raw.route
      });
      return {
        ...metrics,
        rects: raw.rects,
        mutations: raw.mutations,
        pointers: raw.pointers,
        pageWidth: raw.pageWidth,
        loafs: raw.loafs,
        routeBefore,
        routeAfter: raw.route
      };
    };

    // One pass is Overview through Swap. The return to Overview is a route
    // change, not a swipe, so it is not scored. The warmup pass is discarded.
    const boundaries = HOME_PATHS.length - 1;
    const runPass = async label => {
      await settlePage(page, 0);
      const pass = [];
      for (let step = 0; step < boundaries; step++) {
        const swipe = await swipeOnce();
        pass.push(swipe);
        console.log(
          `${label}  ${HOME_PATHS[step]} -> ${HOME_PATHS[step + 1]}  feel ${swipe.feel}  ${swipe.routeBefore} -> ${swipe.routeAfter}  pointers ${swipe.pointers?.down ?? 0}/${swipe.pointers?.move ?? 0}/${swipe.pointers?.touch ?? 0}`
        );
        await settlePage(page, step + 1);
      }
      return pass;
    };

    const swipes = [];
    if (!swipeRemoved) {
      console.log('warmup pass');
      await runPass('warmup');
      for (let rep = 0; rep < args.reps; rep++) {
        swipes.push(...(await runPass(`pass ${rep + 1}/${args.reps}`)));
      }
    }

    const tapOnce = async (from, to) => {
      const fromId = HOME_IDS[HOME_PATHS.indexOf(from)];
      const toIndex = HOME_PATHS.indexOf(to);
      const toId = HOME_IDS[toIndex];
      await page.evaluate(ids => window.__PERF__.start(ids), [fromId, toId]);
      await sleep(50);
      const t0 = await tapTab(page, cdp, toIndex);
      await sleep(TAP_CAPTURE_MS);
      const raw = await page.evaluate(
        id => ({ ...window.__PERF__.stop(), landed: window.__PERF__.landed(id), tab: window.__PERF__.tabBox() }),
        toId
      );
      const tap = analyzeTap({
        frames: raw.frames,
        leave: raw.paneFrames.map(frame => frame[0]),
        enter: raw.paneFrames.map(frame => frame[1]),
        tabLeft: raw.tab?.left ?? 0,
        tabWidth: raw.tab?.width ?? 0,
        t0,
        landed: raw.landed && homePath(raw.route) === to,
        pings: raw.pings,
        inputDelays: (raw.input || []).map(entry => entry.delay)
      });
      return { ...tap, from, to, route: raw.route };
    };

    // A second tap 120ms into a switch has to land; it is checked, not scored.
    const interruptOnce = async () => {
      await settlePage(page, 0);
      await tapTab(page, cdp, 1);
      await sleep(INTERRUPT_AFTER_MS);
      await tapTab(page, cdp, 2);
      const deadline = Date.now() + TAP_CAPTURE_MS;
      while (Date.now() < deadline) {
        if (await page.evaluate(() => location.hash.startsWith('#/receive') && window.__PERF__.landed('receive')))
          return true;
        await sleep(20);
      }
      return false;
    };

    const tapPass = async (label, passIndex) => {
      const interrupted = await interruptOnce();
      await settlePage(page, 0);
      const taps = [];
      let guarded = null;
      for (let step = 1; step < TAP_PATH.length; step++) {
        const tap = await tapOnce(TAP_PATH[step - 1], TAP_PATH[step]);
        taps.push(tap);
        console.log(
          `${label}  tap ${tap.from} -> ${tap.to}  feel ${tap.tapFeel}  first ${tap.firstFrameMs}ms  settle ${tap.settleMs}ms  dropped ${tap.droppedFrames}  both ${tap.bothVisibleFrames}  ${tap.landed ? 'landed' : `missed ${tap.route}`}`
        );
        const index = HOME_PATHS.indexOf(TAP_PATH[step]);
        await settlePage(page, index).catch(() => {});
        // The panes without a swipe get a sideways drag on a different pane each pass.
        if (swipeRemoved && guarded === null && index === passIndex % HOME_PATHS.length) {
          const check = await probeSwipe(page, cdp, index);
          guarded = unchanged(check.before, check.after);
          if (!guarded) console.log(`swipe guard moved something on ${HOME_IDS[index]}: ${JSON.stringify(check)}`);
        }
      }
      return { taps, interrupted, guarded };
    };

    console.log('tap warmup pass');
    const warm = await tapPass('tap warmup', 0);
    const taps = [];
    const interrupts = { landed: 0, of: 0 };
    const swipeGuards = { passed: 0, of: 0 };
    let tapFailures = warm.interrupted && warm.guarded !== false ? 0 : 1;
    for (let rep = 0; rep < args.reps; rep++) {
      const pass = await tapPass(`tap pass ${rep + 1}/${args.reps}`, rep);
      taps.push(...pass.taps);
      interrupts.of += 1;
      if (pass.interrupted) interrupts.landed += 1;
      else tapFailures += 1;
      if (pass.guarded !== null) {
        swipeGuards.of += 1;
        if (pass.guarded) swipeGuards.passed += 1;
        else tapFailures += 1;
      } else if (swipeRemoved) tapFailures += 1;
    }
    const tapSummary = summarizeTaps(taps);
    console.log(
      `taps landed ${tapSummary.landed}/${tapSummary.taps}  feel ${tapSummary.medianTapFeel}  first ${tapSummary.medianFirstFrameMs}ms  settle ${tapSummary.medianSettleMs}ms  dropped ${tapSummary.droppedFrames}  both-visible ${tapSummary.bothVisibleFrames}  interrupts ${interrupts.landed}/${interrupts.of}  guards ${swipeGuards.passed}/${swipeGuards.of}`
    );

    await settlePage(page, 0);
    // The 200ms and 500ms tap bands, and a 25ms dropped frame, are real-time
    // numbers. The swipe and tab taps keep the 4× throttle so their stalls stay visible.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await sleep(200);
    const inp = await measureInp(page);
    const tabInp = await measureTabInp(page, cdp);
    const list = await measureList(page, cdp);
    console.log(`inp max ${Math.max(...inp).toFixed(0)}ms  taps ${inp.map(value => value.toFixed(0)).join(', ')}`);
    console.log(
      `tab inp max ${Math.max(...tabInp).toFixed(0)}ms  taps ${tabInp.map(value => value.toFixed(0)).join(', ')}`
    );
    console.log(
      `list dropped ${list.dropped.map(value => value.toFixed(1)).join(', ')}%  p95 ${list.p95.map(value => value.toFixed(1)).join(', ')}ms`
    );

    const stamp = gitStamp();
    const record = {
      label: args.label,
      at: new Date().toISOString(),
      sha: stamp.sha,
      dirty: stamp.dirty,
      throttle: args.throttle,
      dpr: args.dpr,
      viewport: { width: 600, height: 844 },
      pageWidth: swipes[0]?.pageWidth ?? box.width,
      idleMedianFrameMs,
      hit,
      trace: swipes[0]?.trace ?? [],
      swipes: swipes.map(({ loafs: _loafs, trace: _trace, ...rest }) => rest),
      loafs: loafLeaders(swipes),
      summary: summarize(swipes),
      swipeRemoved,
      taps,
      tapSummary,
      interrupts,
      swipeGuards
    };
    appendFileSync(RESULTS, `${JSON.stringify(record)}\n`);
    if (args.summary) {
      writeFileSync(
        args.summary,
        `${JSON.stringify({
          label: record.label,
          sha: record.sha,
          throttle: record.throttle,
          dpr: record.dpr,
          idleMedianFrameMs: record.idleMedianFrameMs,
          samples: swipeRemoved ? null : record.swipes.map(swipe => swipe.feel),
          swipeRemoved,
          tapFeel: taps.map(tap => tap.tapFeel),
          tapFirstFrame: taps.map(tap => tap.firstFrameMs),
          tapSettle: taps.map(tap => tap.settleMs),
          tapDropped: taps.map(tap => tap.droppedFrames),
          tapTotals: {
            reversals: tapSummary.reversals,
            stallFrames: tapSummary.stallFrames,
            bothVisibleFrames: tapSummary.bothVisibleFrames
          },
          interrupts,
          swipeGuards,
          tabInp,
          inp,
          listDropped: list.dropped,
          listP95: list.p95,
          commits: record.summary.commits,
          swipes: record.summary.swipes
        })}\n`
      );
    }
    printReport(record);
    if (errors.length) console.log(`console errors during the run: ${errors.slice(-5).join(' | ')}`);
    if (swipes.some(swipe => !Number.isFinite(swipe.feel))) return 1;
    if (!swipeRemoved && swipes.length !== args.reps * boundaries) return 1;
    if (tapFailures > 0 || tapSummary.landed !== tapSummary.taps) return 1;
    if (taps.length !== args.reps * (TAP_PATH.length - 1) || taps.some(tap => !Number.isFinite(tap.tapFeel))) return 1;
    if (tabInp.length !== TAB_INP_TAPS || tabInp.some(value => !Number.isFinite(value))) return 1;
    if (inp.length !== INP_TAPS || inp.some(value => !Number.isFinite(value))) return 1;
    if (list.dropped.length !== LIST_RUNS || list.p95.length !== LIST_RUNS) return 1;
    return record.summary.commits === record.summary.swipes ? 0 : 1;
  } catch (error) {
    const url = page.url();
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400)).catch(() => '');
    console.log(`page ${url}`);
    if (body) console.log(body);
    if (errors.length) console.log(errors.slice(-12).join('\n'));
    throw error;
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await context.close();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    'node scripts/home-swipe-bench.mjs [--label name] [--throttle 4] [--reps 6] [--dpr 2] [--rebuild] [--summary file]'
  );
  console.log(
    '--reps is the number of passes from Overview to Swap: four swipes, where the panes page on one, and five tab taps.'
  );
  console.log('node scripts/home-swipe-bench.mjs --compare <baseline-label> <candidate-label>');
  process.exit(0);
}

if (args.rebuild) rebuildBundle();
const code = args.compare ? printCompare(args.compare[0], args.compare[1]) : await measure(args);
process.exit(code);
