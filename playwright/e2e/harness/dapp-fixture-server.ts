/**
 * Local dApp fixture server for the dApp-browser E2E suites.
 *
 * WHY a local server instead of the real featured dApps: the suite asserts on
 * what the dApp webview actually renders, so the page under test has to be
 * deterministic — a live third-party dApp changes its markup, its load time and
 * its uptime independently of this repo, which would make every visual
 * assertion a coin flip. Everything the PRODUCT does stays real: a real native
 * WKWebView / Android WebView, the real `@miden/dapp-browser` plugin, real
 * rect updates, a real page load over real HTTP. Only the bytes on the other
 * end are pinned.
 *
 * The pages are built to be an ORACLE for two questions the suite must answer:
 *
 *  1. "Is the right dApp visible, and is it actually painted?"
 *     Each page floods its viewport with a distinct, saturated brand colour.
 *     A device screenshot cropped to the slot can then be checked for that
 *     colour — which fails if the slot is blank/white (nothing painted), shows
 *     the wrong session, or is covered by wallet chrome.
 *
 *  2. "Did the page RE-LAY-OUT after the webview was resized?"
 *     This is the subtle one, and it is the reason the pages talk back to this
 *     server. A native webview can be resized while its web content keeps the
 *     layout it had at the old size — the frame is correct, the content inside
 *     is stale. A screenshot alone is weak evidence there (a solid colour looks
 *     identical at both sizes). So every page reports its own
 *     `innerWidth`/`innerHeight` here on load and on every `resize`, and the
 *     test compares that against the slot rect the wallet asked for. A mismatch
 *     is a re-render failure, stated in the page's own numbers.
 *
 * The reporting channel is a plain `fetch` from the page to this server. It is
 * deliberately NOT the wallet's dApp-message bridge: routing the oracle through
 * the product's own IPC would mean a bug in that bridge could make a broken
 * re-render look healthy.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** One dApp page served by the fixture. */
export interface FixtureDapp {
  /** Path segment + reporting key, e.g. `alpha`. */
  id: string;
  /** Human-visible title, also the document title the capsule bar should show. */
  name: string;
  /** Saturated background colour, as `[r, g, b]`. Checked against screenshots. */
  rgb: [number, number, number];
}

/** What a fixture page last told us about its own layout. */
export interface DappViewportReport {
  id: string;
  /** `window.innerWidth` in CSS px at the moment of the report. */
  width: number;
  /** `window.innerHeight` in CSS px. */
  height: number;
  devicePixelRatio: number;
  /** Monotonic per-page counter; lets a test require a NEW report, not a stale one. */
  seq: number;
  /** Why the page reported: first paint, a resize, or regaining visibility. */
  reason: 'load' | 'resize' | 'visible';
  /** Server receipt time (ms). */
  at: number;
}

/** The three dApps the suite drives. Colours are far apart in RGB space so a
 *  dominant-colour check can't confuse them even after JPEG-ish compression. */
export const FIXTURE_DAPPS: readonly FixtureDapp[] = [
  { id: 'alpha', name: 'Alpha Fixture', rgb: [220, 40, 40] },
  { id: 'beta', name: 'Beta Fixture', rgb: [40, 90, 220] },
  { id: 'gamma', name: 'Gamma Fixture', rgb: [30, 160, 90] }
];

/**
 * Generation palette for the staleness marker.
 *
 * A solid-colour page looks IDENTICAL whether the webview is presenting a fresh
 * frame or a stale one it rendered before a resize — which is exactly the
 * failure mode "maximizing doesn't re-render" produces. So each page paints a
 * square in its top-left corner whose colour advances every time the page
 * reports (load / resize / regained visibility). The test knows how many
 * reports the page has made, so it knows which colour the square MUST be; a
 * stale frame shows the previous colour and fails on pixels alone.
 *
 * Chosen to be far from every dApp colour and from white/black, so neither the
 * dominant-colour check nor the blank check can be confused by the marker.
 */
export const GENERATION_COLORS: ReadonlyArray<[number, number, number]> = [
  [250, 200, 40],
  [140, 40, 200],
  [40, 210, 210]
];

/** Side length (CSS px) of the generation marker square. */
export const GENERATION_MARKER_PX = 96;

export function fixtureDapp(id: string): FixtureDapp {
  const dapp = FIXTURE_DAPPS.find(d => d.id === id);
  if (!dapp) throw new Error(`[dapp-fixture] unknown fixture dApp '${id}'`);
  return dapp;
}

/**
 * The page. Kept dependency-free and tiny so it paints on the first frame —
 * a slow page would make "is it painted yet" ambiguous.
 *
 * `position: fixed; inset: 0` (rather than a percentage height) makes the fill
 * track the VISUAL viewport exactly, so a stale layout shows up as a
 * wrong-sized colour block rather than being masked by the body stretching.
 */
function pageHtml(dapp: FixtureDapp): string {
  const [r, g, b] = dapp.rgb;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${dapp.name}</title>
<style>
  html, body { margin: 0; padding: 0; background: rgb(${r}, ${g}, ${b}); }
  #fill {
    position: fixed; inset: 0;
    background: rgb(${r}, ${g}, ${b});
    color: #fff;
    font: 700 clamp(18px, 6vw, 52px)/1.2 -apple-system, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.4em; text-align: center; -webkit-font-smoothing: antialiased;
  }
  #size { font-variant-numeric: tabular-nums; }
  #seq { font-size: 0.45em; opacity: 0.85; }
  /* Staleness marker — see GENERATION_COLORS. Top-left of the VISUAL viewport
     so it maps to the top-left of the wallet's slot rect. */
  #gen {
    position: fixed; left: 0; top: 0;
    width: ${GENERATION_MARKER_PX}px; height: ${GENERATION_MARKER_PX}px;
  }
</style>
</head>
<body>
  <div id="fill">
    <div id="name">${dapp.name}</div>
    <div id="size">0×0</div>
    <div id="seq">#0</div>
  </div>
  <div id="gen"></div>
<script>
(function () {
  var id = ${JSON.stringify(dapp.id)};
  var seq = 0;
  var GEN = ${JSON.stringify(GENERATION_COLORS)};
  function paint(w, h) {
    document.getElementById('size').textContent = w + '\\u00d7' + h;
    document.getElementById('seq').textContent = '#' + seq;
    // Advance the staleness marker. seq starts at 1 for the first report, so
    // generation index is (seq - 1) % GEN.length.
    var c = GEN[(seq - 1) % GEN.length];
    document.getElementById('gen').style.background = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }
  function report(reason) {
    seq += 1;
    var w = window.innerWidth;
    var h = window.innerHeight;
    paint(w, h);
    // Expose for anything that can evaluate JS in this webview.
    window.__FIXTURE_STATE__ = { id: id, width: w, height: h, seq: seq, reason: reason };
    try {
      fetch('/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: id, width: w, height: h,
          devicePixelRatio: window.devicePixelRatio || 1,
          seq: seq, reason: reason
        }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('resize', function () { report('resize'); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) report('visible');
  });
  if (document.readyState === 'complete') report('load');
  else window.addEventListener('load', function () { report('load'); });
})();
</script>
</body>
</html>`;
}

export interface DappFixtureServer {
  /** Port the server is listening on (ephemeral unless one is requested). */
  readonly port: number;
  /** URL a device should load for `id`, using the host that device can reach. */
  urlFor(id: string): string;
  /** Latest report for `id`, or undefined if the page never reported. */
  lastReport(id: string): DappViewportReport | undefined;
  /** Every report seen for `id`, oldest first. Useful for asserting a resize happened. */
  reports(id: string): DappViewportReport[];
  /** Drop recorded reports (per-test isolation without restarting the server). */
  reset(): void;
  /** How many times `id` was requested — proves a real page load occurred. */
  loadCount(id: string): number;
  stop(): Promise<void>;
}

export interface StartFixtureServerOpts {
  /**
   * Host the DEVICE uses to reach this machine. iOS Simulator shares the host
   * network so `127.0.0.1` works; the Android emulator maps the host to
   * `10.0.2.2`. Physical devices need the LAN IP.
   */
  deviceHost: string;
  /** Fixed port, or 0 for an ephemeral one (default). */
  port?: number;
}

export async function startDappFixtureServer(opts: StartFixtureServerOpts): Promise<DappFixtureServer> {
  const reportsById = new Map<string, DappViewportReport[]>();
  const loadsById = new Map<string, number>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');

    if (req.method === 'POST' && url.pathname === '/report') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Omit<DappViewportReport, 'at'>;
          const list = reportsById.get(parsed.id) ?? [];
          list.push({ ...parsed, at: Date.now() });
          reportsById.set(parsed.id, list);
        } catch {
          // A malformed report is a fixture bug, not a product signal — drop it
          // rather than failing the request and perturbing the page under test.
        }
        // CORS: the page posts to its own origin, but keep this permissive so a
        // future cross-origin fixture doesn't silently lose its reports.
        res.writeHead(204, { 'access-control-allow-origin': '*' });
        res.end();
      });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS'
      });
      res.end();
      return;
    }

    const dappMatch = /^\/dapp\/([a-z0-9-]+)\/?$/.exec(url.pathname);
    if (req.method === 'GET' && dappMatch) {
      const id = dappMatch[1]!;
      const dapp = FIXTURE_DAPPS.find(d => d.id === id);
      if (!dapp) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('unknown fixture dApp');
        return;
      }
      loadsById.set(id, (loadsById.get(id) ?? 0) + 1);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // Every open must be a real load, not a cache replay — the suite counts loads.
        'cache-control': 'no-store, no-cache, must-revalidate'
      });
      res.end(pageHtml(dapp));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    urlFor(id: string): string {
      fixtureDapp(id); // throws on typo'd ids rather than serving a 404 to the device
      return `http://${opts.deviceHost}:${port}/dapp/${id}`;
    },
    lastReport(id: string): DappViewportReport | undefined {
      const list = reportsById.get(id);
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    },
    reports(id: string): DappViewportReport[] {
      return [...(reportsById.get(id) ?? [])];
    },
    reset(): void {
      reportsById.clear();
      loadsById.clear();
    },
    loadCount(id: string): number {
      return loadsById.get(id) ?? 0;
    },
    async stop(): Promise<void> {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
