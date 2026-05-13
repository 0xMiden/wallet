import { execFile } from 'child_process';
import { promisify } from 'util';

import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

const SELECT_PAGE_TIMEOUT = 60_000;
const SELECT_PAGE_POLL_MS = 1_500;

interface ConnectOpts {
  serial: string;
  packageName: string;
  /** Host port to forward to the device's WebView devtools socket. */
  hostPort: number;
  /**
   * Substring or regex to pick the right WebView when the app has several
   * (e.g. main host webview + a dapp-browser webview). Defaults to
   * matching the wallet's `http://localhost/` host.
   */
  pickPageUrl?: RegExp | string;
}

export interface CdpConsoleEntry {
  level: string;
  text: string;
  ts: number;
  source?: string;
}

export interface CdpStats {
  evalCount: number;
  evalMs: number;
  evalAsyncCount: number;
  evalAsyncMs: number;
  evaluateCount: number;
  evaluateMs: number;
}

/**
 * Wraps a single Chrome DevTools Protocol page connection inside the
 * wallet's Capacitor WebView. Surface mirrors the iOS `CdpSession`
 * (eval/evalAsync/evaluate/onConsoleLog) — wallet POM code doesn't branch
 * on platform.
 *
 * Transport differences from iOS:
 *   - Android WebViews speak vanilla CDP (not WebKit Inspector), so we
 *     don't need appium-remote-debugger; a plain WebSocket suffices.
 *   - Page discovery is `GET http://127.0.0.1:<port>/json` (Chrome DevTools
 *     HTTP endpoint), not `simctl spawn launchctl print` socket discovery.
 *   - The page filter has to skip the dapp-browser WebView (which exists
 *     as a sibling page when the wallet opens an InAppBrowser instance).
 */
export class CdpSession {
  private consoleListeners: Array<(entry: CdpConsoleEntry) => void> = [];
  private pendingByMethod = new Map<string, Array<(params: unknown) => void>>();
  private pending = new Map<number, (msg: CdpResponse) => void>();
  private nextId = 1;
  private closed = false;
  private consoleEnabled = false;
  private stats: CdpStats = {
    evalCount: 0,
    evalMs: 0,
    evalAsyncCount: 0,
    evalAsyncMs: 0,
    evaluateCount: 0,
    evaluateMs: 0,
  };

  constructor(
    private ws: WebSocket,
    private hostPort: number,
    private serial: string
  ) {
    ws.on('message', data => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
      } else if (msg.method) {
        const cbs = this.pendingByMethod.get(msg.method);
        if (cbs) for (const cb of cbs) cb(msg.params ?? {});
      }
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  getStats(): CdpStats {
    return { ...this.stats };
  }

  /**
   * Evaluate a synchronous JS body. Mirrors the iOS interface where the
   * caller writes a function body including `return`. We wrap it in an
   * IIFE before sending so the body works with CDP's `Runtime.evaluate`
   * (which takes an EXPRESSION, not a function body).
   */
  async eval<T = unknown>(body: string): Promise<T> {
    const start = Date.now();
    try {
      const expression = `(function(){${body}})()`;
      const res = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false,
      });
      throwIfException(res);
      return (res.result as { result?: { value: T } }).result?.value as T;
    } finally {
      this.stats.evalCount++;
      this.stats.evalMs += Date.now() - start;
    }
  }

  /**
   * Evaluate an async JS body. Convention matches iOS: the body's last
   * argument is the callback. To map onto CDP we wrap in an IIFE that
   * returns a Promise resolved via the callback, then use
   * `awaitPromise: true`.
   */
  async evalAsync<T = unknown>(body: string, opts: { timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const expression =
      `(function(){return new Promise(function(__resolve){` +
      `var __cb = function(v){__resolve(v);};` +
      `try { (function(){${body}}).call(this, __cb); } catch(e) { __resolve(undefined); } ` +
      `});})()`;
    const start = Date.now();
    const exec = this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`evalAsync: callback not invoked within ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      const res = (await Promise.race([exec, timeout])) as CdpResponse;
      throwIfException(res);
      return (res.result as { result?: { value: T } }).result?.value as T;
    } finally {
      if (timer) clearTimeout(timer);
      this.stats.evalAsyncCount++;
      this.stats.evalAsyncMs += Date.now() - start;
    }
  }

  /**
   * Evaluate a function in the page context. Function must not capture
   * closure variables — same constraint as iOS's `evaluate(fn)`.
   */
  async evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    const expression = `(${fn.toString()})()`;
    const start = Date.now();
    try {
      const res = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      throwIfException(res);
      return (res.result as { result?: { value: T } }).result?.value as T;
    } finally {
      this.stats.evaluateCount++;
      this.stats.evaluateMs += Date.now() - start;
    }
  }

  onConsoleLog(cb: (entry: CdpConsoleEntry) => void): () => void {
    this.consoleListeners.push(cb);
    if (!this.consoleEnabled) {
      this.consoleEnabled = true;
      void this.send('Runtime.enable', {});
      const list = this.pendingByMethod.get('Runtime.consoleAPICalled') ?? [];
      list.push(params => {
        const p = params as RuntimeConsoleAPICalled;
        const text = (p.args ?? [])
          .map(a => (typeof a.value === 'string' ? a.value : (a.description ?? JSON.stringify(a.value))))
          .join(' ');
        for (const listener of this.consoleListeners) {
          listener({ level: p.type ?? 'log', text, ts: p.timestamp ?? Date.now() });
        }
      });
      this.pendingByMethod.set('Runtime.consoleAPICalled', list);
    }
    return () => {
      this.consoleListeners = this.consoleListeners.filter(l => l !== cb);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      await execFileAsync('adb', ['-s', this.serial, 'forward', '--remove', `tcp:${this.hostPort}`]);
    } catch {
      /* ignore */
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private send(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    const id = this.nextId++;
    return new Promise<CdpResponse>((resolve, reject) => {
      this.pending.set(id, msg => {
        if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
        else resolve(msg);
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

/**
 * Per-emulator CDP bridge. One CdpBridge per (serial, packageName) pair.
 */
export class CdpBridge {
  static async connect(opts: ConnectOpts): Promise<CdpSession> {
    const { serial, packageName, hostPort } = opts;
    const pageFilter = normalizePageFilter(opts.pickPageUrl);

    // Forward tcp:hostPort → device's webview_devtools_remote_<pid> abstract
    // socket. The PID must match the app's main process — we look it up
    // each time because PIDs change across launches.
    const pid = await pidOf(serial, packageName);
    if (pid == null) {
      throw new Error(`CdpBridge: package ${packageName} not running on ${serial} (pidof returned nothing)`);
    }
    await execFileAsync('adb', [
      '-s',
      serial,
      'forward',
      `tcp:${hostPort}`,
      `localabstract:webview_devtools_remote_${pid}`,
    ]);

    // Poll for the wallet's main WebView page to register. After cold app
    // launch the WebView takes 1-3s to bind to webview_devtools_remote_<pid>.
    const start = Date.now();
    let target: CdpPage | undefined;
    while (Date.now() - start < SELECT_PAGE_TIMEOUT) {
      try {
        const list = (await fetchJson<CdpPage[]>(`http://127.0.0.1:${hostPort}/json`)) ?? [];
        target = list.find(p => pageFilter.test(p.url ?? '')) ?? list[0];
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        // devtools endpoint not up yet — keep polling
      }
      await sleep(SELECT_PAGE_POLL_MS);
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(
        `CdpBridge: no WebView page found for ${packageName} on ${serial} within ` +
          `${SELECT_PAGE_TIMEOUT}ms. Is setWebContentsDebuggingEnabled(true)? (debug builds default on)`
      );
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', err => reject(err));
    });

    return new CdpSession(ws, hostPort, serial);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

interface CdpPage {
  id: string;
  url?: string;
  title?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RuntimeConsoleAPICalled {
  type?: string;
  args?: Array<{ value?: unknown; description?: string }>;
  timestamp?: number;
}

function throwIfException(res: CdpResponse): void {
  const r = res.result as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (r?.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page threw';
    throw new Error(`CDP eval threw: ${text}`);
  }
}

function normalizePageFilter(pickPageUrl: RegExp | string | undefined): RegExp {
  if (pickPageUrl instanceof RegExp) return pickPageUrl;
  if (typeof pickPageUrl === 'string') return new RegExp(pickPageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Default: wallet's main webview is hosted at http://localhost/. The
  // dapp-browser WebView lives at the dApp's own URL (e.g.
  // https://faucet.testnet.miden.io/), so the prefix match is enough to
  // disambiguate.
  return /^http:\/\/localhost\//;
}

async function pidOf(serial: string, packageName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'pidof', packageName]);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
