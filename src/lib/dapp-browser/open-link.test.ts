/* eslint-disable import/first */
const mockAddListener = jest.fn();
const mockGetLaunchUrl = jest.fn();
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (...args: unknown[]) => mockAddListener(...args),
    getLaunchUrl: () => mockGetLaunchUrl()
  }
}));

import {
  __resetOpenLinksForTest,
  acceptOpenLink,
  getPendingOpenLink,
  OPEN_LINK_HOST,
  parseOpenLink,
  startOpenLinkCapture,
  subscribePendingOpenLink,
  takePendingOpenLink
} from './open-link';

const PAGE = 'https://app.example.com/swap?pair=MIDEN-USDC';
const LINK = `https://${OPEN_LINK_HOST}/open?url=${encodeURIComponent(PAGE)}`;
const LIVE = 'https://live.example/';
const LIVE_LINK = `com.miden.wallet://open?url=${encodeURIComponent(LIVE)}`;

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  sessionStorage.clear();
  __resetOpenLinksForTest();
  mockAddListener.mockReset().mockResolvedValue({ remove: jest.fn() });
  mockGetLaunchUrl.mockReset().mockResolvedValue(undefined);
});

describe('parseOpenLink', () => {
  it('reads the page out of a universal link or an app link', () => {
    expect(parseOpenLink(LINK)).toBe(PAGE);
    expect(parseOpenLink(`https://BREAD.miden.xyz/open?url=${encodeURIComponent(PAGE)}`)).toBe(PAGE);
  });

  it('reads the page out of the custom scheme link', () => {
    expect(parseOpenLink(`com.miden.wallet://open?url=${encodeURIComponent(PAGE)}`)).toBe(PAGE);
    expect(parseOpenLink(`com.miden.wallet://open/?url=${encodeURIComponent(PAGE)}#top`)).toBe(PAGE);
    expect(parseOpenLink(`COM.MIDEN.WALLET://open?url=${encodeURIComponent(PAGE)}`)).toBe(PAGE);
  });

  it('normalizes the page', () => {
    expect(parseOpenLink(`${LINK.split('?')[0]}?url=${encodeURIComponent('https://App.Example.com')}`)).toBe(
      'https://app.example.com/'
    );
  });

  it.each([
    ['another host', `https://evil.example/open?url=${encodeURIComponent(PAGE)}`],
    [
      'a host that only starts like ours',
      `https://${OPEN_LINK_HOST}.evil.example/open?url=${encodeURIComponent(PAGE)}`
    ],
    ['another path', `https://${OPEN_LINK_HOST}/other?url=${encodeURIComponent(PAGE)}`],
    ['plain http', `http://${OPEN_LINK_HOST}/open?url=${encodeURIComponent(PAGE)}`],
    ['another scheme action', `com.miden.wallet://other?url=${encodeURIComponent(PAGE)}`],
    ['no page', `https://${OPEN_LINK_HOST}/open`],
    ['no query', 'com.miden.wallet://open'],
    ['an empty page', `com.miden.wallet://open?url=`],
    ['not a URL', 'open bread']
  ])('ignores a link with %s', (_case, link) => {
    expect(parseOpenLink(link)).toBeNull();
  });

  it.each([
    ['an http page', 'http://app.example.com/'],
    // Concatenated rather than written out: the literal trips `no-script-url`.
    ['a script page', `${'java'}${'script'}:alert(1)`],
    ['a data page', 'data:text/html,<h1>hi</h1>'],
    ['credentials before the host', 'https://app.example.com@evil.example/'],
    ['a password', 'https://user:secret@app.example.com/'],
    ['a page that is not a URL', 'app.example.com']
  ])('refuses %s', (_case, page) => {
    expect(parseOpenLink(`https://${OPEN_LINK_HOST}/open?url=${encodeURIComponent(page)}`)).toBeNull();
  });
});

describe('pending open link', () => {
  it('holds the newest accepted page and tells subscribers', () => {
    const listener = jest.fn();
    subscribePendingOpenLink(listener);

    acceptOpenLink(LINK, 1_000);
    expect(getPendingOpenLink()).toBe(PAGE);

    const other = 'https://other.example/';
    acceptOpenLink(`com.miden.wallet://open?url=${encodeURIComponent(other)}`, 1_100);
    expect(getPendingOpenLink()).toBe(other);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('leaves the slot alone for a link it refuses', () => {
    const listener = jest.fn();
    subscribePendingOpenLink(listener);

    acceptOpenLink(`https://${OPEN_LINK_HOST}/open?url=${encodeURIComponent('http://app.example.com/')}`);

    expect(getPendingOpenLink()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands the page over once', () => {
    acceptOpenLink(LINK, 1_000);
    const listener = jest.fn();
    subscribePendingOpenLink(listener);

    expect(takePendingOpenLink()).toBe(PAGE);
    expect(getPendingOpenLink()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    expect(takePendingOpenLink()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops a second delivery of the same link shortly after the first', () => {
    acceptOpenLink(LINK, 1_000);
    takePendingOpenLink();

    acceptOpenLink(LINK, 2_500);
    expect(getPendingOpenLink()).toBeNull();

    acceptOpenLink(LINK, 3_500);
    expect(getPendingOpenLink()).toBe(PAGE);
  });

  it('stops telling a subscriber that unsubscribed', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePendingOpenLink(listener);
    unsubscribe();

    acceptOpenLink(LINK);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('startOpenLinkCapture', () => {
  it('accepts links the app is opened with while running', async () => {
    startOpenLinkCapture();
    await flushPromises();

    expect(mockAddListener).toHaveBeenCalledTimes(1);
    expect(mockAddListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
    const onUrlOpen = mockAddListener.mock.calls[0][1] as (event: { url: string }) => void;
    onUrlOpen({ url: LINK });

    expect(getPendingOpenLink()).toBe(PAGE);
  });

  it('accepts the link that launched the app, once even when iOS also replays it as an event', async () => {
    mockGetLaunchUrl.mockResolvedValue({ url: LINK });
    const listener = jest.fn();
    subscribePendingOpenLink(listener);

    startOpenLinkCapture();
    await flushPromises();
    const onUrlOpen = mockAddListener.mock.calls[0][1] as (event: { url: string }) => void;
    onUrlOpen({ url: LINK });

    expect(getPendingOpenLink()).toBe(PAGE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a live link over a launch link that settles later', async () => {
    let settleLaunch: (launch: { url: string }) => void = () => {};
    mockGetLaunchUrl.mockReturnValue(
      new Promise(resolve => {
        settleLaunch = resolve;
      })
    );

    startOpenLinkCapture();
    const onUrlOpen = mockAddListener.mock.calls[0][1] as (event: { url: string }) => void;
    onUrlOpen({ url: LIVE_LINK });
    settleLaunch({ url: LINK });
    await flushPromises();

    expect(getPendingOpenLink()).toBe(LIVE);
  });

  // A reload re-runs the module with fresh state; sessionStorage and the platform's launch URL outlive it.
  it('does not offer a taken launch link again after a reload', async () => {
    mockGetLaunchUrl.mockResolvedValue({ url: LINK });
    startOpenLinkCapture();
    await flushPromises();
    expect(takePendingOpenLink()).toBe(PAGE);

    __resetOpenLinksForTest();
    startOpenLinkCapture();
    await flushPromises();

    expect(getPendingOpenLink()).toBeNull();
  });

  it('keeps a held live link across a reload', async () => {
    startOpenLinkCapture();
    const onUrlOpen = mockAddListener.mock.calls[0][1] as (event: { url: string }) => void;
    onUrlOpen({ url: LIVE_LINK });

    __resetOpenLinksForTest();
    startOpenLinkCapture();
    await flushPromises();

    expect(getPendingOpenLink()).toBe(LIVE);
  });

  it('still takes the launch link after a live link that is not an open link', async () => {
    let settleLaunch: (launch: { url: string }) => void = () => {};
    mockGetLaunchUrl.mockReturnValue(
      new Promise(resolve => {
        settleLaunch = resolve;
      })
    );

    startOpenLinkCapture();
    const onUrlOpen = mockAddListener.mock.calls[0][1] as (event: { url: string }) => void;
    onUrlOpen({ url: 'com.miden.wallet://' });
    settleLaunch({ url: LINK });
    await flushPromises();

    expect(getPendingOpenLink()).toBe(PAGE);
  });

  it.each([
    ['unreadable', '['],
    ['not a list', '"taken"']
  ])('offers the launch link when the taken record is %s', async (_case, record) => {
    sessionStorage.setItem('open-link:taken', record);
    mockGetLaunchUrl.mockResolvedValue({ url: LINK });

    startOpenLinkCapture();
    await flushPromises();

    expect(getPendingOpenLink()).toBe(PAGE);
  });

  it('does not restore a stored link that is not an open link', async () => {
    sessionStorage.setItem('open-link:pending', `https://evil.example/open?url=${encodeURIComponent(LIVE)}`);
    mockGetLaunchUrl.mockResolvedValue({ url: LINK });

    startOpenLinkCapture();
    await flushPromises();

    expect(getPendingOpenLink()).toBe(PAGE);
  });

  it('holds and hands over a link without storage', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    const spies = [
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(denied),
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(denied),
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied)
    ];
    mockGetLaunchUrl.mockResolvedValue({ url: LINK });

    startOpenLinkCapture();
    await flushPromises();

    expect(takePendingOpenLink()).toBe(PAGE);
    expect(getPendingOpenLink()).toBeNull();
    for (const spy of spies) spy.mockRestore();
  });

  it('starts once', async () => {
    startOpenLinkCapture();
    startOpenLinkCapture();
    await flushPromises();

    expect(mockAddListener).toHaveBeenCalledTimes(1);
    expect(mockGetLaunchUrl).toHaveBeenCalledTimes(1);
  });

  it('survives the plugin failing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAddListener.mockRejectedValue(new Error('not implemented'));
    mockGetLaunchUrl.mockRejectedValue(new Error('not implemented'));

    startOpenLinkCapture();
    await flushPromises();

    expect(getPendingOpenLink()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
