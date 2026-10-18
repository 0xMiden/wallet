/**
 * The mobile page's side of the command channel (spec 3.3, helpers/dapp-command-server.ts). It long-polls the harness
 * for `window.testDapp.call` commands, posts each answer, and reports the page's life as events. It imports nothing,
 * so it runs and reports even when the SDK's module graph never finishes evaluating. It never gates a command on
 * `document.visibilityState`, which reads differently on each platform while the wallet hides the page.
 */
// A module, though it exports nothing: as a script its top-level names would be globals across the whole program.
export {};

interface PageCommand {
  id: string;
  command: string;
  input: unknown;
}
type Answer = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

// What Bread's Android WebView answers a page's ready() when it has no gated presentation path
// (packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/BreadPresentationController.java:249).
const UNSUPPORTED_PRESENTATION = 'Native presentation is unsupported in this WebView';

const params = new URLSearchParams(window.location.search);
const dapp = window.location.hostname === '127.0.0.1' ? 'two' : 'one';
const key = `device=${encodeURIComponent(params.get('device') ?? '')}&dapp=${dapp}`;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// The wait after a failed poll. The server's poll gap is built on it, so command-loop.test.ts pins it to PAGE_RETRY_MS.
const RETRY_MS = 1_000;

function describeError(error: unknown): { name: string; message: string } {
  const read = (prop: string): unknown =>
    typeof error === 'object' && error !== null ? Reflect.get(error, prop) : undefined;
  const name = read('name');
  const message = read('message');
  return {
    name: typeof name === 'string' ? name : 'NonError',
    message: typeof message === 'string' ? message : String(error)
  };
}

function post(pathname: string, body: string, keepalive = false): Promise<boolean> {
  return fetch(`${pathname}?${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    cache: 'no-store',
    keepalive
  }).then(
    response => response.status >= 200 && response.status < 300,
    () => false
  );
}

function report(kind: string, data: Record<string, unknown> = {}, keepalive = false): void {
  void post('/event', JSON.stringify({ kind, at: Date.now(), visibility: document.visibilityState, data }), keepalive);
}

function testDapp(): { ready: boolean; call: ((command: string, input: unknown) => Promise<unknown>) | undefined } {
  const api: unknown = Reflect.get(window, 'testDapp');
  if (typeof api !== 'object' || api === null) return { ready: false, call: undefined };
  const call: unknown = Reflect.get(api, 'call');
  return {
    ready: Reflect.get(api, 'ready') === true,
    call:
      typeof call === 'function' ? (name, input) => Promise.resolve(Reflect.apply(call, api, [name, input])) : undefined
  };
}

// Bread's document-start presentation layer (presentation-script.ts) and the page's language, for the record.
function pageFacts(): Record<string, unknown> {
  const state: unknown = Reflect.get(window, '__breadPresentationState');
  const display: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'display') : undefined;
  return {
    presentationToken: typeof Reflect.get(window, '__breadPresentationToken') === 'string',
    presentation: typeof display === 'string' ? display : null,
    language: navigator.language
  };
}

function snapshot(): Record<string, unknown> {
  return {
    href: window.location.href,
    origin: window.location.origin,
    isSecureContext: window.isSecureContext,
    visibility: document.visibilityState,
    provider: typeof Reflect.get(window, 'midenWallet'),
    ready: testDapp().ready,
    ...pageFacts()
  };
}

async function run(command: PageCommand): Promise<unknown> {
  if (command.command === '__state') return snapshot();
  if (command.command === '__fetchLog') return Reflect.get(window, '__dappFetchLog') ?? [];
  const api = testDapp();
  if (!api.ready || api.call === undefined) throw new Error('window.testDapp is not ready');
  return api.call(command.command, command.input);
}

function answerBody(command: PageCommand, answer: Answer): string {
  try {
    return JSON.stringify({ id: command.id, ...answer });
  } catch (error) {
    // A result JSON cannot carry (a bigint, a cycle) would otherwise go unanswered and read as a page that hung.
    return JSON.stringify({
      id: command.id,
      ok: false,
      error: {
        name: 'HarnessCheckError',
        message: `the ${command.command} result cannot be sent: ${describeError(error).message}`
      }
    });
  }
}

async function dispatch(command: PageCommand): Promise<void> {
  const answer: Answer = await run(command).then(
    (value): Answer => ({ ok: true, value }),
    (error: unknown): Answer => ({ ok: false, error: describeError(error) })
  );
  const body = answerBody(command, answer);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await post('/result', body)) return;
    if (attempt < 3) await sleep(RETRY_MS);
  }
  report('result-undelivered', { id: command.id, command: command.command, attempts: 3 });
}

async function loop(): Promise<void> {
  for (let n = 1; ; n += 1) {
    try {
      const response = await fetch(`/command?${key}&poll=${n}`, { cache: 'no-store' });
      if (response.status === 200) {
        const body: unknown = await response.json();
        const read = (prop: string): unknown =>
          typeof body === 'object' && body !== null ? Reflect.get(body, prop) : undefined;
        const id = read('id');
        const name = read('command');
        if (typeof id !== 'string' || typeof name !== 'string') {
          report('pollStatus', { status: 200, malformed: true });
          await sleep(RETRY_MS);
          continue;
        }
        // Not awaited: a command waiting on the approval sheet must not stop the next poll.
        void dispatch({ id, command: name, input: read('input') });
      } else if (response.status === 409) {
        // A newer poll for this key took over, so another loop owns it: this one stops, or the two trade 409s forever.
        report('pollSuperseded', { poll: n });
        return;
      } else if (response.status !== 204) {
        report('pollStatus', { status: response.status });
        await sleep(RETRY_MS);
      }
    } catch (error) {
      report('pollError', describeError(error));
      await sleep(RETRY_MS);
    }
  }
}

// The page asks itself, because the presentation script's own ready() on load swallows a rejection
// (presentation-script.ts loaded()); the fallback's exact answer is the only one that names it.
async function probePresentation(): Promise<void> {
  const bread: unknown = Reflect.get(window, 'bread');
  const presentation: unknown =
    typeof bread === 'object' && bread !== null ? Reflect.get(bread, 'presentation') : undefined;
  const ready: unknown =
    typeof presentation === 'object' && presentation !== null ? Reflect.get(presentation, 'ready') : undefined;
  if (typeof ready !== 'function') {
    report('presentation', { path: 'absent', detail: 'window.bread.presentation.ready is not a function' });
    return;
  }
  try {
    await Reflect.apply(ready, presentation, []);
    report('presentation', { path: 'gated', detail: 'ready() resolved' });
  } catch (error) {
    const { message } = describeError(error);
    report('presentation', { path: message === UNSUPPORTED_PRESENTATION ? 'fallback' : 'other', detail: message });
  }
}

function watch(kind: string, present: () => boolean): void {
  if (present()) {
    report(kind, { atBoot: true });
    return;
  }
  const timer = setInterval(() => {
    if (!present()) return;
    clearInterval(timer);
    report(kind, { atBoot: false });
  }, 100);
}

report('boot', {
  origin: window.location.origin,
  href: window.location.href,
  isSecureContext: window.isSecureContext,
  userAgent: navigator.userAgent,
  readyState: document.readyState,
  providerAtBoot: typeof Reflect.get(window, 'midenWallet'),
  ...pageFacts()
});
window.addEventListener('load', () => {
  report('load');
  void probePresentation();
});
document.addEventListener('visibilitychange', () => report('visibility'));
window.addEventListener('pagehide', event => report('pagehide', { persisted: event.persisted }, true));
window.addEventListener('error', event => report('pageError', { message: event.message }));
window.addEventListener('unhandledrejection', event => report('unhandledRejection', describeError(event.reason)));
watch('provider', () => Reflect.get(window, 'midenWallet') !== undefined);
watch('ready', () => testDapp().ready);
void loop();
