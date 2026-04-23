import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  createRemoteDebugger,
  type RemoteDebugger,
  type RemoteDebuggerOptions,
} from 'appium-remote-debugger';

const execFileAsync = promisify(execFile);

const SELECT_APP_TIMEOUT = 60_000;
const SELECT_APP_POLL_MS = 1_500;
const PAGE_READY_TIMEOUT = 15_000;
const SOCKET_DISCOVERY_TIMEOUT = 30_000;

interface ConnectOpts {
  udid: string;
  bundleId: string;
  /** iOS major.minor version, e.g. "26.3". Auto-detected if omitted. */
  platformVersion?: string;
}

export interface CdpConsoleEntry {
  level: string;
  text: string;
  ts: number;
  source?: string;
}

/**
 * Connection to one simulator's WebKit Inspector daemon. Wraps appium's
 * RemoteDebugger so the rest of the harness only sees a CDP-like surface
 * (eval, evaluate, console).
 */
export interface CdpStats {
  evalCount: number;
  evalMs: number;
  evalAsyncCount: number;
  evalAsyncMs: number;
  evaluateCount: number;
  evaluateMs: number;
}

export class CdpSession {
  private consoleListeners: Array<(entry: CdpConsoleEntry) => void> = [];
  private stats: CdpStats = {
    evalCount: 0,
    evalMs: 0,
    evalAsyncCount: 0,
    evalAsyncMs: 0,
    evaluateCount: 0,
    evaluateMs: 0,
  };

  constructor(private rd: RemoteDebugger) {}

  /** Read the current call stats snapshot. */
  getStats(): CdpStats {
    return { ...this.stats };
  }

  /**
   * Evaluate synchronous JavaScript and return the result. The body is the
   * function body for `executeAtom('execute_script', ...)`; callers MUST
   * include their own `return` statement (mirrors WebDriver's
   * `executeScript`). Multi-statement bodies are fine.
   *
   * For Promise-returning code, use `evalAsync` — `eval` resolves the
   * Promise object itself, not its value.
   */
  async eval<T = unknown>(body: string): Promise<T> {
    const start = Date.now();
    try {
      return (await (this.rd as unknown as ExecuteAtomCapable).executeAtom('execute_script', [
        body,
        [],
      ])) as T;
    } finally {
      this.stats.evalCount++;
      this.stats.evalMs += Date.now() - start;
    }
  }

  /**
   * Evaluate asynchronous JavaScript. The body MUST call the callback
   * `arguments[arguments.length - 1]` with its result — this is the
   * `execute_async_script` WebDriver atom contract. Useful when the page
   * code awaits Promises (store.fetchBalances, intercom.request, etc.).
   *
   * The optional outer timeout protects against scripts that never invoke
   * the callback — without it, executeAtomAsync waits forever. Default 30s.
   */
  async evalAsync<T = unknown>(body: string, opts: { timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const exec = (this.rd as unknown as ExecuteAtomCapable).executeAtomAsync(
      'execute_async_script',
      [body, []]
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`evalAsync: script did not invoke callback within ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    const start = Date.now();
    try {
      return (await Promise.race([exec, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
      this.stats.evalAsyncCount++;
      this.stats.evalAsyncMs += Date.now() - start;
    }
  }

  /**
   * Evaluate a function in the page context. Matches Playwright's
   * Page.evaluate(fn) signature so the same closure works on both Chrome and
   * iOS without branching at the call site.
   *
   * Constraint: the passed function MUST NOT reference closure variables —
   * it's stringified via Function.prototype.toString and re-parsed in the
   * page. Callers in this harness only read window.__TEST_* globals.
   */
  async evaluate<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    const body = `return (${fn.toString()})();`;
    const start = Date.now();
    try {
      return (await (this.rd as unknown as ExecuteAtomCapable).executeAtom('execute_script', [
        body,
        [],
      ])) as T;
    } finally {
      this.stats.evaluateCount++;
      this.stats.evaluateMs += Date.now() - start;
    }
  }

  /**
   * Subscribe to console.* output from the page. Returns an unsubscribe fn.
   */
  onConsoleLog(cb: (entry: CdpConsoleEntry) => void): () => void {
    this.consoleListeners.push(cb);
    if (this.consoleListeners.length === 1) {
      (this.rd as unknown as ConsoleCapable).startConsole((event: WebKitConsoleEvent) => {
        const m = event?.params?.message;
        if (!m) return;
        const entry: CdpConsoleEntry = {
          level: m.level ?? 'log',
          text: extractConsoleText(m),
          ts: m.timestamp ?? Date.now(),
          source: m.source,
        };
        for (const listener of this.consoleListeners) listener(entry);
      });
    }
    return () => {
      this.consoleListeners = this.consoleListeners.filter(l => l !== cb);
      if (this.consoleListeners.length === 0) {
        try {
          (this.rd as unknown as ConsoleCapable).stopConsole();
        } catch {
          // ignore
        }
      }
    };
  }

  async close(): Promise<void> {
    try {
      (this.rd as unknown as ConsoleCapable).stopConsole();
    } catch {
      // ignore
    }
    await this.rd.disconnect();
  }
}

/**
 * Per-simulator CDP bridge. There is no central daemon process — each
 * CdpBridge owns one RemoteDebugger talking to one webinspectord_sim socket.
 * Two simulators in parallel = two CdpBridges.
 */
export class CdpBridge {
  /**
   * Open a connection to the WebKit Inspector for the given simulator and
   * select the first page belonging to the given bundleId. Returns a session
   * usable for repeated eval/evaluate calls.
   */
  static async connect(connectOpts: ConnectOpts): Promise<CdpSession> {
    const { udid, bundleId } = connectOpts;
    const socketPath = await discoverInspectorSocket(udid);
    const platformVersion = connectOpts.platformVersion ?? (await detectIOSVersion(udid));

    const opts: RemoteDebuggerOptions = {
      bundleId,
      additionalBundleIds: ['*'],
      platformVersion,
      isSafari: false,
      includeSafari: false,
      socketPath,
      pageLoadMs: 1_000,
      pageReadyTimeout: PAGE_READY_TIMEOUT,
    };
    const rd = createRemoteDebugger(opts, false);

    await rd.connect();

    // Poll for the app's WebView to register with webinspectord_sim. After a
    // fresh `simctl launch`, registration can take 5–15s while the WKWebView
    // initializes. Bail out only if the whole window passes empty-handed.
    let pages: Array<{ id: string; url?: string; title?: string }> = [];
    const selectStart = Date.now();
    while (Date.now() - selectStart < SELECT_APP_TIMEOUT) {
      try {
        pages = await (rd as unknown as SelectAppCapable).selectApp(null, 3, true);
        if (pages && pages.length > 0) break;
      } catch {
        // selectApp throws when no apps are connected at all — keep polling.
      }
      await sleep(SELECT_APP_POLL_MS);
    }
    if (!pages || pages.length === 0) {
      await rd.disconnect();
      throw new Error(
        `CdpBridge: no pages found for bundleId=${bundleId} on udid=${udid} ` +
          `within ${SELECT_APP_TIMEOUT}ms. Is the app running and built with ` +
          `isInspectable=true?`
      );
    }

    // Page id is "<appKey>.<pageNum>" — selectPage takes them split.
    const pageId = pages[0]!.id;
    const dotIndex = pageId.indexOf('.');
    if (dotIndex < 0) {
      await rd.disconnect();
      throw new Error(`CdpBridge: malformed page id "${pageId}"`);
    }
    const appKey = pageId.slice(0, dotIndex);
    const pageNum = parseInt(pageId.slice(dotIndex + 1), 10);
    await (rd as unknown as SelectPageCapable).selectPage(appKey, pageNum);

    return new CdpSession(rd);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

interface ExecuteAtomCapable {
  executeAtom(name: string, args: unknown[]): Promise<unknown>;
  executeAtomAsync(name: string, args: unknown[]): Promise<unknown>;
}
interface SelectAppCapable {
  selectApp(currentUrl: string | null, maxTries: number, ignoreAboutBlankUrl: boolean): Promise<
    Array<{ id: string; url?: string; title?: string }>
  >;
}
interface SelectPageCapable {
  selectPage(appKey: string, pageNum: number): Promise<void>;
}
interface ConsoleCapable {
  startConsole(listener: (event: WebKitConsoleEvent) => void): void;
  stopConsole(): void;
}

interface WebKitConsoleEvent {
  params?: {
    message?: {
      level?: string;
      text?: string;
      source?: string;
      timestamp?: number;
      parameters?: Array<{ value?: unknown; description?: string }>;
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function extractConsoleText(m: NonNullable<WebKitConsoleEvent['params']>['message']): string {
  if (!m) return '';
  if (m.text) return m.text;
  if (m.parameters) {
    return m.parameters
      .map(p => (typeof p.value === 'string' ? p.value : (p.description ?? JSON.stringify(p.value))))
      .join(' ');
  }
  return '';
}

/**
 * Resolve the per-simulator UNIX socket exposed by webinspectord_sim. iOS
 * picks a fresh `/private/tmp/com.apple.launchd.<RANDOM>/` socket each boot,
 * so we have to ask launchd inside the sim for the current path.
 */
async function discoverInspectorSocket(udid: string): Promise<string> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < SOCKET_DISCOVERY_TIMEOUT) {
    try {
      const { stdout } = await execFileAsync('xcrun', [
        'simctl',
        'spawn',
        udid,
        'launchctl',
        'print',
        'user/501',
      ]);
      // Look for a line like:
      //   "RWI_LISTEN_SOCKET" => /private/tmp/com.apple.launchd.../com.apple.webinspectord_sim.socket
      const match = stdout.match(/RWI_LISTEN_SOCKET[^/]*([/\w.\-]+webinspectord_sim\.socket)/);
      if (match?.[1]) return match[1];
    } catch (err) {
      lastErr = err;
    }
    await sleep(1_000);
  }
  throw new Error(
    `CdpBridge: webinspectord_sim socket for udid=${udid} not found within ` +
      `${SOCKET_DISCOVERY_TIMEOUT}ms. ${lastErr ? 'Last error: ' + String(lastErr) : ''}`
  );
}

async function detectIOSVersion(udid: string): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '--json', 'devices']);
  const parsed = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string }>> };
  // The runtime key looks like "com.apple.CoreSimulator.SimRuntime.iOS-26-3"
  for (const [runtimeKey, list] of Object.entries(parsed.devices)) {
    if (list.some(d => d.udid === udid)) {
      const m = runtimeKey.match(/iOS-(\d+)-(\d+)/);
      if (m) return `${m[1]}.${m[2]}`;
    }
  }
  // Fallback — recent default
  return '26.3';
}
