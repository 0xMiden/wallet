import { INJECTION_SCRIPT } from './injection-script';
import { PRESENTATION_SCRIPT, type AuthReply, type AuthRequest, type PresentationMessage } from './presentation-script';

type AuthListener = (event: { data: string }) => void;
interface IosAuth {
  postMessage: (body: { url: string }) => Promise<unknown>;
}
interface IosAuthCall {
  body: { url: string };
  resolve: (reply: unknown) => void;
  reject: (error: Error) => void;
}
interface AndroidAuth {
  postMessage: (value: string) => void;
  addEventListener?: (type: string, listener: AuthListener) => void;
  onmessage?: AuthListener;
}
interface PageWindow {
  midenWallet?: object;
  top?: PageWindow;
  webkit?: { messageHandlers: { breadPresentation: { postMessage: (value: string) => void }; breadAuth?: IosAuth } };
  breadPresentation?: { postMessage: (value: string) => void };
  breadAuth?: AndroidAuth;
  bread?: {
    version: number;
    presentation: { ready: () => Promise<void>; close: () => Promise<void> };
    auth?: { version: number; open: (url: unknown) => Promise<{ url: string } | { cancelled: true }> };
  };
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
function page(metadata = '', transport: 'ios' | 'android' | 'none' = 'ios', auth = false) {
  const doc = document.implementation.createHTMLDocument();
  doc.head.innerHTML = metadata;
  const messages: PresentationMessage[] = [];
  const postMessage = (value: string) => messages.push(JSON.parse(value));
  const iosAuthCalls: IosAuthCall[] = [];
  const iosAuth: IosAuth = {
    postMessage: body => new Promise((resolve, reject) => iosAuthCalls.push({ body, resolve, reject }))
  };
  const authRequests: AuthRequest[] = [];
  let authListener: AuthListener | undefined;
  const androidAuth: AndroidAuth = {
    postMessage: value => authRequests.push(JSON.parse(value)),
    addEventListener: (type, listener) => {
      if (type === 'message') authListener = listener;
    }
  };
  const win: PageWindow = {};
  win.top = win;
  if (transport === 'ios') {
    win.webkit = { messageHandlers: { breadPresentation: { postMessage } } };
    if (auth) win.webkit.messageHandlers.breadAuth = iosAuth;
  }
  if (transport === 'android') {
    win.breadPresentation = { postMessage };
    if (auth) win.breadAuth = androidAuth;
  }
  // eslint-disable-next-line no-new-func
  const evaluate = () => new Function('window', 'document', PRESENTATION_SCRIPT)(win, doc);
  const loaded = () => doc.dispatchEvent(new Event('DOMContentLoaded'));
  const respond = (message: PresentationMessage, ok = true, token = message.token) => {
    if (!message.requestId) throw new Error('Missing API request id');
    win.__breadPresentationRespond?.({ token, requestId: message.requestId, ok, error: 'Rejected by native' });
  };
  const nativeReply = (reply: AuthReply | string) => {
    if (!authListener) throw new Error('Missing auth listener');
    authListener({ data: typeof reply === 'string' ? reply : JSON.stringify(reply) });
  };
  const postedAuthUrls = () => [
    ...iosAuthCalls.map(call => call.body.url),
    ...authRequests.map(request => request.url)
  ];
  return {
    doc,
    win,
    messages,
    evaluate,
    loaded,
    respond,
    iosAuth,
    iosAuthCalls,
    androidAuth,
    authRequests,
    nativeReply,
    postedAuthUrls
  };
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
  const p = page('', 'ios', true);
  p.evaluate();
  const api = p.win.bread!.presentation;
  const auth = p.win.bread!.auth;
  const token = p.win.__breadPresentationToken;
  p.evaluate();
  p.loaded();
  p.loaded();
  expect(p.win.bread!.presentation).toBe(api);
  expect(p.win.bread!.auth).toBe(auth);
  expect(auth?.version).toBe(1);
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
  const child = page('', 'ios', true);
  child.win.breadAuth = child.androidAuth;
  child.win.top = {};
  child.evaluate();
  expect(child.win.bread).toBeUndefined();
  expect(child.messages).toHaveLength(0);
  expect(child.postedAuthUrls()).toHaveLength(0);
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

const TRANSPORTS: Array<'ios' | 'android'> = ['ios', 'android'];
const AUTH_ERRORS = [
  'AUTH_NOT_MAIN_FRAME',
  'AUTH_INSECURE_PAGE',
  'AUTH_INVALID_URL',
  'AUTH_BUSY',
  'AUTH_UNAVAILABLE',
  'AUTH_FAILED'
];
const SIGN_IN_URL = 'https://dapp.example/sign-in';
const CALLBACK_URL = 'com.miden.wallet.auth://callback?login=a%2Fb&x=1';

it('adds a frozen auth API beside presentation when the auth transport exists', () => {
  for (const transport of TRANSPORTS) {
    const p = page('', transport, true);
    p.evaluate();
    const bread = p.win.bread!;
    expect(Object.keys(bread)).toEqual(['version', 'presentation', 'auth']);
    expect(bread.version).toBe(1);
    expect(bread.auth).toEqual({ version: 1, open: expect.any(Function) });
    expect(Object.isFrozen(bread)).toBe(true);
    expect(Object.isFrozen(bread.auth)).toBe(true);
  }
});

it('omits auth when only the presentation transport exists', async () => {
  for (const transport of TRANSPORTS) {
    const p = page('', transport);
    p.evaluate();
    expect('auth' in p.win.bread!).toBe(false);
    const ready = p.win.bread!.presentation.ready();
    expect(p.messages).toMatchObject([{ type: 'ready' }]);
    p.respond(p.messages[0]!);
    await expect(ready).resolves.toBeUndefined();
  }
});

it('iOS: never uses window.breadAuth as the auth transport', () => {
  const p = page();
  p.win.breadAuth = p.androidAuth;
  p.evaluate();
  expect('auth' in p.win.bread!).toBe(false);
});

it('iOS: posts {url} once and resolves a frozen {url} untouched', async () => {
  const p = page('', 'ios', true);
  p.evaluate();
  const pending = p.win.bread!.auth!.open(SIGN_IN_URL);
  expect(p.iosAuthCalls.map(call => call.body)).toEqual([{ url: SIGN_IN_URL }]);
  p.iosAuthCalls[0]!.resolve({ url: CALLBACK_URL });
  const result = await pending;
  expect(result).toEqual({ url: CALLBACK_URL });
  expect(Object.isFrozen(result)).toBe(true);
});

it('iOS: resolves a frozen {cancelled: true}', async () => {
  const p = page('', 'ios', true);
  p.evaluate();
  const pending = p.win.bread!.auth!.open(SIGN_IN_URL);
  p.iosAuthCalls[0]!.resolve({ cancelled: true });
  const result = await pending;
  expect(result).toEqual({ cancelled: true });
  expect(Object.isFrozen(result)).toBe(true);
});

it.each(AUTH_ERRORS)('rejects with the native code %s on both transports', async code => {
  const ios = page('', 'ios', true);
  ios.evaluate();
  const fromIos = ios.win.bread!.auth!.open(SIGN_IN_URL);
  ios.iosAuthCalls[0]!.reject(new Error(code));
  await expect(fromIos).rejects.toThrow(new Error(code));
  const android = page('', 'android', true);
  android.evaluate();
  const fromAndroid = android.win.bread!.auth!.open(SIGN_IN_URL);
  android.nativeReply({ id: android.authRequests[0]!.id, error: code });
  await expect(fromAndroid).rejects.toThrow(new Error(code));
});

it('maps an unknown native error or a malformed reply to AUTH_FAILED', async () => {
  const ios = page('', 'ios', true);
  const android = page('', 'android', true);
  ios.evaluate();
  android.evaluate();
  const failed = [ios, ios, ios, android, android, android].map(p =>
    expect(p.win.bread!.auth!.open(SIGN_IN_URL)).rejects.toThrow(new Error('AUTH_FAILED'))
  );
  ios.iosAuthCalls[0]!.reject(new Error('boom'));
  ios.iosAuthCalls[1]!.resolve({});
  ios.iosAuthCalls[2]!.resolve({ url: 1 });
  const [first, second, third] = android.authRequests.map(request => request.id);
  android.nativeReply({ id: first!, error: 'boom' });
  android.nativeReply({ id: second! });
  android.nativeReply(JSON.stringify({ id: third, url: 1 }));
  await Promise.all(failed);
});

it('rejects a non-string or over-long url locally as AUTH_INVALID_URL', async () => {
  const longest = SIGN_IN_URL + 'a'.repeat(4096 - SIGN_IN_URL.length);
  for (const transport of TRANSPORTS) {
    const p = page('', transport, true);
    p.evaluate();
    const auth = p.win.bread!.auth!;
    await expect(auth.open(1)).rejects.toThrow(new Error('AUTH_INVALID_URL'));
    await expect(auth.open(longest + 'a')).rejects.toThrow(new Error('AUTH_INVALID_URL'));
    expect(p.postedAuthUrls()).toEqual([]);
    void auth.open(longest);
    expect(p.postedAuthUrls()).toEqual([longest]);
  }
});

it('Android: correlates out-of-order replies by document-scoped id', async () => {
  const p = page('', 'android', true);
  p.evaluate();
  const first = p.win.bread!.auth!.open(SIGN_IN_URL);
  const second = p.win.bread!.auth!.open(SIGN_IN_URL);
  const token = p.win.__breadPresentationToken!;
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(p.authRequests).toEqual([
    { id: `${token}_auth_1`, url: SIGN_IN_URL },
    { id: `${token}_auth_2`, url: SIGN_IN_URL }
  ]);
  p.nativeReply({ id: `${token}_auth_2`, cancelled: true });
  p.nativeReply({ id: `${token}_auth_1`, url: CALLBACK_URL });
  await expect(first).resolves.toEqual({ url: CALLBACK_URL });
  await expect(second).resolves.toEqual({ cancelled: true });
});

it('Android: ignores malformed, unknown and repeated replies', async () => {
  const p = page('', 'android', true);
  p.evaluate();
  const pending = p.win.bread!.auth!.open(SIGN_IN_URL);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const id = p.authRequests[0]!.id;
  p.nativeReply('not json');
  p.nativeReply('null');
  p.nativeReply('7');
  p.nativeReply({ id: `${'0'.repeat(32)}_auth_1`, error: 'AUTH_BUSY' });
  await Promise.resolve();
  expect(settled).toBe(false);
  p.nativeReply({ id, url: CALLBACK_URL });
  p.nativeReply({ id, error: 'AUTH_BUSY' });
  await expect(pending).resolves.toEqual({ url: CALLBACK_URL });
});

it('Android: falls back to onmessage without addEventListener', async () => {
  const p = page('', 'android', true);
  delete p.androidAuth.addEventListener;
  p.evaluate();
  const pending = p.win.bread!.auth!.open(SIGN_IN_URL);
  p.androidAuth.onmessage!({ data: JSON.stringify({ id: p.authRequests[0]!.id, url: CALLBACK_URL }) });
  await expect(pending).resolves.toEqual({ url: CALLBACK_URL });
});

it('keeps a sign-in pending past the presentation timeout', async () => {
  const ios = page('', 'ios', true);
  const android = page('', 'android', true);
  ios.evaluate();
  android.evaluate();
  const fromIos = ios.win.bread!.auth!.open(SIGN_IN_URL);
  const fromAndroid = android.win.bread!.auth!.open(SIGN_IN_URL);
  jest.advanceTimersByTime(600000);
  ios.iosAuthCalls[0]!.resolve({ url: CALLBACK_URL });
  android.nativeReply({ id: android.authRequests[0]!.id, url: CALLBACK_URL });
  await expect(fromIos).resolves.toEqual({ url: CALLBACK_URL });
  await expect(fromAndroid).resolves.toEqual({ url: CALLBACK_URL });
});

it('turns a throwing transport into a rejected promise', async () => {
  const android = page('', 'android', true);
  android.androidAuth.postMessage = value => {
    android.authRequests.push(JSON.parse(value));
    throw new Error('boom');
  };
  android.evaluate();
  const fromAndroid = android.win.bread!.auth!.open(SIGN_IN_URL);
  android.nativeReply({ id: android.authRequests[0]!.id, url: CALLBACK_URL });
  await expect(fromAndroid).rejects.toThrow(new Error('AUTH_FAILED'));
  const ios = page('', 'ios', true);
  ios.iosAuth.postMessage = () => {
    throw new Error('boom');
  };
  ios.evaluate();
  await expect(ios.win.bread!.auth!.open(SIGN_IN_URL)).rejects.toThrow(new Error('AUTH_FAILED'));
});
