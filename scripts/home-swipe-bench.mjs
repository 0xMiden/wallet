#!/usr/bin/env node
/**
 * Headless Chrome benchmark for the home-carousel swipe.
 *
 * This is a proxy for a thumb, not a phone. It opens the mobile bundle, creates
 * a mock wallet once, and drives the real carousel with trusted touch events
 * on a steady clock. The main thread is slowed (`--throttle`, default 4) so a
 * fast laptop shows the stalls a phone would. The score lives in
 * `home-swipe-score.mjs`: the track has to land on the next page and stay with
 * the finger. A smooth frame trace that does not move still counts as a miss.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { analyzeSwipe, homePath, judge, median, summarize } from './home-swipe-score.mjs';

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
          delay: entry.processingStart - entry.startTime,
          duration: entry.duration
        });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  } catch { /* event timing missing */ }

  P.findTrack = () => {
    const container = document.querySelector('div.touch-pan-y');
    return container ? container.firstElementChild : null;
  };
  P.readX = el => {
    if (!el) return null;
    const transform = getComputedStyle(el).transform;
    if (!transform || transform === 'none') return 0;
    const matrix = new DOMMatrixReadOnly(transform);
    return matrix.m41;
  };
  P.box = () => {
    const container = document.querySelector('div.touch-pan-y');
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
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
  P.start = () => {
    P.frames = [];
    P.xs = [];
    P.pings = [];
    P.loafs = [];
    P.input = [];
    P.rects = 0;
    P.mutations = 0;
    P.pointers = { down: 0, move: 0, touch: 0 };
    P.recording = true;
    P.generation = (P.generation || 0) + 1;
    const gen = P.generation;
    const track = P.findTrack();
    P.trackFound = !!track;
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
      P.xs.push(P.readX(track));
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
    const container = document.querySelector('div.touch-pan-y');
    return {
      frames: P.frames,
      xs: P.xs,
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
  console.log(`${leftLabel}  feel ${left.summary.medianFeel}  follow ${left.summary.medianFollowP95Px}px  worst ${left.summary.medianWorstFrameMs}ms  commits ${left.summary.commits}/${left.summary.swipes}`);
  console.log(`${rightLabel}  feel ${right.summary.medianFeel}  follow ${right.summary.medianFollowP95Px}px  worst ${right.summary.medianWorstFrameMs}ms  commits ${right.summary.commits}/${right.summary.swipes}`);
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
    createReadStream(file).pipe(res);
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
      track: !!document.querySelector('div.touch-pan-y'),
      hash: location.hash,
      text: (document.body?.innerText || '').slice(0, 180)
    };
  });
}

async function reachHome(page) {
  page.setDefaultTimeout(180_000);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const deadline = Date.now() + 240_000;
  let bypassed = false;
  let submitted = false;
  let unlocked = false;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (Date.now() - lastLog > 15_000) {
      console.log(
        `waiting for home: status=${snap.status} welcome=${snap.welcome} confirm=${snap.confirm} unlock=${snap.unlock} track=${snap.track}`
      );
      lastLog = Date.now();
    }
    if (snap.track && snap.status === 2) {
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

async function dispatchPointer(page, type, x, y) {
  return page.evaluate(
    ({ type, x, y }) => {
      const probe = window.__PERF__;
      if (type === 'pointerdown') {
        probe.gestureTarget = document.elementFromPoint(x, y) || probe.findTrack();
      }
      const target = probe.gestureTarget || probe.findTrack();
      if (!target) return;
      // Framer follows pointer events. Chrome claims a trusted touch on the
      // overview scroller for itself and never delivers the pointermoves, so a
      // finger made of touch events slides nothing. These are the events the
      // carousel actually listens to, stamped on the runner's clock.
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          buttons: type === 'pointerup' ? 0 : 1,
          pressure: type === 'pointerup' ? 0 : 0.5
        })
      );
      // The page's clock, taken after the handler ran. A timestamp from the
      // runner would include the trip into the page and blame the harness for
      // the wait.
      return performance.now();
    },
    { type, x, y }
  );
}

async function driveSwipe(page, box) {
  const y = Math.round(box.top + box.height * 0.78);
  const x0 = Math.round(box.left + box.width * 0.8);
  const x1 = Math.round(box.left + box.width * 0.22);
  const durationMs = 240;
  const stepMs = 8;
  const steps = Math.round(durationMs / stepMs);
  const events = [];

  events.push({ t: await dispatchPointer(page, 'pointerdown', x0, y), x: x0, type: 'down' });

  let next = performance.now() + stepMs;
  for (let i = 1; i <= steps; i++) {
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    events.push({ t: await dispatchPointer(page, 'pointermove', x, y), x, type: 'move' });
    next += stepMs;
  }

  events.push({ t: await dispatchPointer(page, 'pointerup', x1, y), x: x1, type: 'up' });
  return { events, point: { x: x0, y } };
}

async function settleOverview(page) {
  await page.evaluate(() => {
    if (location.hash !== '#/' && location.hash !== '#' && location.hash !== '') location.hash = '#/';
  });
  const deadline = Date.now() + 8000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => ({
      hash: location.hash,
      x: window.__PERF__.readX(window.__PERF__.findTrack())
    }));
    if (homePath(last.hash) === '/' && last.x != null && Math.abs(last.x) < 2) return last;
    await sleep(40);
  }
  throw new Error(`overview did not settle: ${JSON.stringify(last)}`);
}

function loafLeaders(swipes) {
  const totals = new Map();
  for (const swipe of swipes) {
    for (const loaf of swipe.loafs || []) {
      const scripts = loaf.scripts?.length ? loaf.scripts : [{ fn: '(unattributed)', file: '', duration: loaf.duration }];
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
    await settleOverview(page);

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.throttle });
    await page.evaluate(() => window.__PERF__.start());
    await sleep(500);
    const idle = await page.evaluate(() => window.__PERF__.stop());
    const idleDeltas = [];
    for (let i = 1; i < idle.frames.length; i++) idleDeltas.push(idle.frames[i] - idle.frames[i - 1]);
    const idleMedianFrameMs = Math.round(median(idleDeltas) * 10) / 10;
    if (idleMedianFrameMs > 22) {
      console.log(`idle frames already ${idleMedianFrameMs}ms at throttle ${args.throttle}; the swipe will be hard to tell apart from the throttle itself`);
    }

    const box = await page.evaluate(() => window.__PERF__.box());
    if (!box || box.width < 50) throw new Error(`swipe container has no size: ${JSON.stringify(box)}`);
    const hit = await page.evaluate(({ x, y }) => window.__PERF__.hit(x, y), {
      x: Math.round(box.left + box.width * 0.8),
      y: Math.round(box.top + box.height * 0.78)
    });

    const runSwipe = async () => {
      await settleOverview(page);
      const routeBefore = await page.evaluate(() => location.hash);
      await page.evaluate(() => window.__PERF__.start());
      await sleep(50);
      const finger = await driveSwipe(page, box);
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

    console.log('warmup swipe');
    await runSwipe();

    const swipes = [];
    for (let rep = 0; rep < args.reps; rep++) {
      const swipe = await runSwipe();
      swipes.push(swipe);
      console.log(
        `rep ${rep + 1}/${args.reps}  feel ${swipe.feel}  ${swipe.routeBefore} -> ${swipe.routeAfter}  pointers ${swipe.pointers?.down ?? 0}/${swipe.pointers?.move ?? 0}/${swipe.pointers?.touch ?? 0}`
      );
    }

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
      summary: summarize(swipes)
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
          samples: record.swipes.map(swipe => swipe.feel),
          commits: record.summary.commits,
          swipes: record.summary.swipes
        })}\n`
      );
    }
    printReport(record);
    if (errors.length) console.log(`console errors during the run: ${errors.slice(-5).join(' | ')}`);
    if (swipes.some(swipe => !Number.isFinite(swipe.feel))) return 1;
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
  console.log('node scripts/home-swipe-bench.mjs [--label name] [--throttle 4] [--reps 6] [--dpr 2] [--rebuild] [--summary file]');
  console.log('node scripts/home-swipe-bench.mjs --compare <baseline-label> <candidate-label>');
  process.exit(0);
}

if (args.rebuild) rebuildBundle();
const code = args.compare ? printCompare(args.compare[0], args.compare[1]) : await measure(args);
process.exit(code);
