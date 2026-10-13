import { INJECTION_SCRIPT } from './injection-script';
import { PRESENTATION_SCRIPT, type PresentationMessage } from './presentation-script';

interface PageWindow {
  midenWallet?: object;
  top?: PageWindow;
  webkit?: { messageHandlers: { breadPresentation: { postMessage: (value: string) => void } } };
  breadPresentation?: { postMessage: (value: string) => void };
  bread?: { version: number; presentation: { ready: () => Promise<void>; close: () => Promise<void> } };
  __breadPresentationToken?: string;
  __breadPresentationState?: { token: string; display: string; controlBounds?: object; safeAreaInsets?: object };
  __breadPresentationRespond?: (response: { token: string; requestId: string; ok: boolean; error?: string }) => void;
  __breadPresentationUpdate?: (update: {
    token: string;
    display: string;
    controlInsetTop: number;
    controlBounds?: unknown;
    safeAreaInsets?: unknown;
  }) => void;
}
function page(metadata = '', transport: 'ios' | 'android' | 'none' = 'ios') {
  const doc = document.implementation.createHTMLDocument();
  doc.head.innerHTML = metadata;
  const messages: PresentationMessage[] = [];
  const postMessage = (value: string) => messages.push(JSON.parse(value));
  const win: PageWindow = {};
  win.top = win;
  if (transport === 'ios') win.webkit = { messageHandlers: { breadPresentation: { postMessage } } };
  if (transport === 'android') win.breadPresentation = { postMessage };
  // eslint-disable-next-line no-new-func
  const evaluate = () => new Function('window', 'document', PRESENTATION_SCRIPT)(win, doc);
  const loaded = () => doc.dispatchEvent(new Event('DOMContentLoaded'));
  const respond = (message: PresentationMessage, ok = true, token = message.token) => {
    if (!message.requestId) throw new Error('Missing API request id');
    win.__breadPresentationRespond?.({ token, requestId: message.requestId, ok, error: 'Rejected by native' });
  };
  return { doc, win, messages, evaluate, loaded, respond };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('configures fullscreen metadata early and waits for explicit readiness', async () => {
  const p = page('<meta name="bread-display" content="fullscreen"><meta name="bread-ready" content="manual">');
  p.evaluate();
  p.loaded();
  expect(p.messages).toMatchObject([{ type: 'configure', display: 'fullscreen', manualReady: true }]);
  const ready = p.win.bread!.presentation.ready();
  p.respond(p.messages[1]!);
  await expect(ready).resolves.toBeUndefined();
});

it.each(['', '<meta name="bread-display" content="immersive">'])(
  'uses ordinary automatic presentation for %s',
  metadata => {
    const p = page(metadata, 'android');
    p.evaluate();
    p.loaded();
    expect(p.messages).toMatchObject([
      { type: 'configure', display: 'browser', manualReady: false },
      { type: 'ready' }
    ]);
  }
);

it('observes metadata while the head is parsing and settles the final metadata', async () => {
  const p = page();
  p.evaluate();
  p.doc.head.innerHTML =
    '<meta name="bread-display" content="fullscreen"><meta name="bread-ready" content="manual"><meta name="theme-color" content="#123456">';
  await Promise.resolve();
  expect(p.messages).toMatchObject([
    { type: 'configure', display: 'fullscreen', manualReady: true, themeColor: '#123456' }
  ]);
  p.doc.head.innerHTML = '';
  p.loaded();
  expect(p.messages).toMatchObject([
    { display: 'fullscreen' },
    { type: 'configure', display: 'browser', manualReady: false },
    { type: 'ready' }
  ]);
});

it('preserves the document token and frozen API on reinjection', () => {
  const p = page();
  p.evaluate();
  const api = p.win.bread!.presentation;
  const token = p.win.__breadPresentationToken;
  p.evaluate();
  p.loaded();
  p.loaded();
  expect(p.win.bread!.presentation).toBe(api);
  expect(Object.isFrozen(api)).toBe(true);
  expect(p.win.bread!.version).toBe(1);
  expect(p.win.__breadPresentationToken).toBe(token);
  expect(p.messages.filter(m => m.type === 'ready')).toHaveLength(1);
});

it('ignores old-token responses and rejects native refusal', async () => {
  const p = page('<meta name="bread-ready" content="manual">');
  p.evaluate();
  const pending = p.win.bread!.presentation.ready();
  const message = p.messages[0]!;
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  p.respond(message, true, 'old-document');
  await Promise.resolve();
  expect(settled).toBe(false);
  p.respond(message, false);
  await expect(pending).rejects.toThrow('Rejected by native');
});

it('sends close only through the dedicated native transport', async () => {
  const p = page('', 'android');
  p.evaluate();
  const pending = p.win.bread!.presentation.close();
  expect(p.messages[0]).toMatchObject({ type: 'close', token: p.win.__breadPresentationToken });
  p.respond(p.messages[0]!);
  await expect(pending).resolves.toBeUndefined();
});

it('bounds pending calls by count and timeout', async () => {
  const p = page();
  p.evaluate();
  const calls = Array.from({ length: 32 }, () => p.win.bread!.presentation.ready());
  await expect(p.win.bread!.presentation.close()).rejects.toThrow('Too many pending presentation requests');
  const expired = calls.map(call => expect(call).rejects.toThrow('Presentation request timed out'));
  jest.advanceTimersByTime(30000);
  await Promise.all(expired);
  const close = p.win.bread!.presentation.close();
  p.respond(p.messages[p.messages.length - 1]!);
  await close;
});

it('applies only current-token native state and a finite inset metric', () => {
  const p = page();
  p.evaluate();
  const token = p.win.__breadPresentationToken!;
  p.win.__breadPresentationUpdate?.({ token: 'old', display: 'fullscreen', controlInsetTop: 50 });
  expect(p.win.__breadPresentationState?.display).toBe('browser');
  p.win.__breadPresentationUpdate?.({ token, display: 'fullscreen', controlInsetTop: 44 });
  expect(p.win.__breadPresentationState?.display).toBe('fullscreen');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-inset-top')).toBe('44px');
  p.win.__breadPresentationUpdate?.({ token, display: 'fullscreen', controlInsetTop: Infinity });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-inset-top')).toBe('44px');
});

it('exposes nothing in ordinary browsers or child frames', () => {
  const ordinary = page('', 'none');
  ordinary.evaluate();
  expect(ordinary.win.bread).toBeUndefined();
  const child = page();
  child.win.top = {};
  child.evaluate();
  expect(child.win.bread).toBeUndefined();
  expect(child.messages).toHaveLength(0);
});

it('refreshes injection padding from actual native presentation state without replacing the API', () => {
  const p = page('<meta name="bread-display" content="fullscreen">');
  p.evaluate();
  p.win.midenWallet = {};
  // eslint-disable-next-line no-new-func
  const inject = () => new Function('window', 'document', INJECTION_SCRIPT)(p.win, p.doc);
  inject();
  p.loaded();
  expect(p.doc.getElementById('miden-wallet-bottom-pad')?.textContent).toContain('96px');
  const api = p.win.bread;
  p.win.__breadPresentationUpdate?.({
    token: p.win.__breadPresentationToken!,
    display: 'fullscreen',
    controlInsetTop: 44
  });
  expect(p.doc.getElementById('miden-wallet-bottom-pad')).toBeNull();
  inject();
  p.loaded();
  expect(p.doc.getElementById('miden-wallet-bottom-pad')).toBeNull();
  expect(p.win.bread).toBe(api);
  p.win.__breadPresentationUpdate?.({ token: p.win.__breadPresentationToken!, display: 'browser', controlInsetTop: 0 });
  expect(p.doc.getElementById('miden-wallet-bottom-pad')?.textContent).toContain('96px');
});

const bounds = { left: 12, top: 62, width: 64, height: 48 };
const safeArea = { top: 54, left: 0, right: 0, bottom: 34 };

it('publishes independently frozen optional geometry and clears it on browser mode', () => {
  const p = page();
  p.evaluate();
  const token = p.win.__breadPresentationToken!;
  p.win.__breadPresentationUpdate?.({
    token,
    display: 'fullscreen',
    controlInsetTop: 118,
    controlBounds: bounds,
    safeAreaInsets: safeArea
  });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-top')).toBe('62px');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-safe-area-bottom')).toBe('34px');
  expect(p.doc.documentElement.dataset.breadControlBounds).toBe('true');
  expect(p.win.__breadPresentationState?.controlBounds).toEqual(bounds);
  expect(Object.isFrozen(p.win.__breadPresentationState?.controlBounds)).toBe(true);
  expect(Object.isFrozen(p.win.__breadPresentationState?.safeAreaInsets)).toBe(true);
  p.win.__breadPresentationUpdate?.({
    token,
    display: 'browser',
    controlInsetTop: 0,
    controlBounds: bounds,
    safeAreaInsets: safeArea
  });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-top')).toBe('');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-safe-area-bottom')).toBe('');
  expect(p.doc.documentElement.dataset.breadControlBounds).toBeUndefined();
  expect(p.win.__breadPresentationState?.controlBounds).toBeUndefined();
});

it.each([
  null,
  {},
  { ...bounds, top: -1 },
  { ...bounds, left: Infinity },
  { ...bounds, width: '64' },
  { ...bounds, height: NaN }
])('falls back to legacy inset for malformed rectangle %p', controlBounds => {
  const p = page();
  p.evaluate();
  const token = p.win.__breadPresentationToken!;
  p.win.__breadPresentationUpdate?.({
    token,
    display: 'fullscreen',
    controlInsetTop: 118,
    controlBounds: bounds,
    safeAreaInsets: safeArea
  });
  p.win.__breadPresentationUpdate?.({
    token,
    display: 'fullscreen',
    controlInsetTop: 130,
    controlBounds,
    safeAreaInsets: { ...safeArea, right: -1 }
  });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-inset-top')).toBe('130px');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-top')).toBe('');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-safe-area-right')).toBe('');
  expect(p.doc.documentElement.dataset.breadControlBounds).toBeUndefined();
});

it('preserves current geometry after stale token and returns to legacy updates safely', () => {
  const p = page();
  p.evaluate();
  const token = p.win.__breadPresentationToken!;
  p.win.__breadPresentationUpdate?.({
    token,
    display: 'fullscreen',
    controlInsetTop: 118,
    controlBounds: bounds,
    safeAreaInsets: safeArea
  });
  p.win.__breadPresentationUpdate?.({ token: 'old', display: 'browser', controlInsetTop: 0 });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-left')).toBe('12px');
  p.win.__breadPresentationUpdate?.({ token, display: 'fullscreen', controlInsetTop: 120 });
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-left')).toBe('');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-inset-top')).toBe('120px');
});

it('keeps valid bounds when optional safe-area data is invalid', () => {
  const p = page();
  p.evaluate();
  p.win.__breadPresentationUpdate?.({
    token: p.win.__breadPresentationToken!,
    display: 'fullscreen',
    controlInsetTop: 118,
    controlBounds: bounds,
    safeAreaInsets: { ...safeArea, bottom: Infinity }
  });
  expect(p.doc.documentElement.dataset.breadControlBounds).toBe('true');
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-width')).toBe('64px');
  expect(p.win.__breadPresentationState?.safeAreaInsets).toBeUndefined();
});

it('keeps geometry snapshots independent of the update objects', () => {
  const p = page();
  p.evaluate();
  const incoming = { ...bounds };
  p.win.__breadPresentationUpdate?.({
    token: p.win.__breadPresentationToken!,
    display: 'fullscreen',
    controlInsetTop: 118,
    controlBounds: incoming,
    safeAreaInsets: safeArea
  });
  incoming.width = 128;
  expect(p.win.__breadPresentationState?.controlBounds).toEqual(bounds);
  expect(p.doc.documentElement.style.getPropertyValue('--bread-control-width')).toBe('64px');
});
