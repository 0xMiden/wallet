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
  BREAD_REQUEST_SCHEME_URL,
  BREAD_REQUEST_URL,
  type DAppMessage,
  sendRequest,
  startConnect,
  toBase64Url
} from '@miden-sdk/bread-connect';

import {
  __resetRequestLinksForTest,
  acceptRequestLink,
  canonicalRequestLink,
  nextRequestLink,
  requestLinkId,
  startRequestLinkCapture,
  subscribeRequestLinks,
  takeRequestLink
} from './capture';
import { BREAD_CONNECT_TAKEN_KEY } from './keys';

const CALLBACK = 'https://game.example/bread';
const REQUEST: DAppMessage = { type: 'PERMISSION_REQUEST', appMeta: { name: 'Game' } };
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';

function connectLink(): { link: string; id: string } {
  const { link, connection } = startConnect(CALLBACK, REQUEST);
  return { link, id: connection.id };
}

function messageLink(message: unknown): string {
  return `${BREAD_REQUEST_URL}#v=1&m=${toBase64Url(new TextEncoder().encode(JSON.stringify(message)))}`;
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  __resetRequestLinksForTest();
  mockAddListener.mockReset().mockResolvedValue({ remove: jest.fn() });
  mockGetLaunchUrl.mockReset().mockResolvedValue(undefined);
});

describe('requestLinkId', () => {
  it('reads the id of a connect or a request', () => {
    const { link, id } = connectLink();
    const app = startConnect(CALLBACK, REQUEST).connection;
    const wallet = startConnect(CALLBACK, REQUEST).connection;
    const request = sendRequest(
      {
        session: ID,
        callback: CALLBACK,
        appSecretKey: app.appSecretKey,
        appPublicKey: app.appPublicKey,
        walletPublicKey: wallet.appPublicKey
      },
      { type: 'SIGN_REQUEST' }
    );

    expect(requestLinkId(link)).toBe(id);
    expect(requestLinkId(request.link)).toBe(request.id);
  });

  it('reads the id a malformed message names, so Bread can refuse it', () => {
    expect(requestLinkId(messageLink({ type: 'connect', callback: CALLBACK, id: ID }))).toBe(ID);
  });

  it.each([
    ['a malformed message without an id', messageLink({ type: 'connect', callback: CALLBACK })],
    [
      'an answer meant for an app',
      messageLink({ type: 'error', id: ID, error: { code: 'NOT_GRANTED', message: 'no' } })
    ],
    [
      'an unsealed transaction outcome',
      messageLink({ type: 'error', id: ID, error: { code: 'TRANSACTION_FAILED', message: 'no' } })
    ],
    ['a link for another receiver', `${CALLBACK}#v=1&m=e30`],
    ['an open link', 'https://bread.miden.xyz/open#url=https%3A%2F%2Fapp.example%2F']
  ])('has none for %s', (_name, link) => {
    expect(requestLinkId(link)).toBeNull();
  });
});

describe('canonicalRequestLink', () => {
  it('rewrites the scheme form the fallback page hands Bread to the https form, and leaves others alone', () => {
    const { link } = connectLink();
    const fragment = link.slice(BREAD_REQUEST_URL.length);

    expect(canonicalRequestLink(`${BREAD_REQUEST_SCHEME_URL}${fragment}`)).toBe(link);
    expect(canonicalRequestLink(link)).toBe(link);
    expect(canonicalRequestLink(`${BREAD_REQUEST_SCHEME_URL}?x=1`)).toBe(`${BREAD_REQUEST_SCHEME_URL}?x=1`);
  });
});

describe('the held links', () => {
  it('holds links in arrival order, each id once, and tells subscribers', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRequestLinks(listener);
    const first = connectLink();
    const second = connectLink();

    acceptRequestLink(first.link);
    acceptRequestLink(first.link);
    acceptRequestLink(second.link);
    acceptRequestLink('https://bread.miden.xyz/open#url=https%3A%2F%2Fapp.example%2F');

    expect(nextRequestLink()).toBe(first.link);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(takeRequestLink()).toBe(first.link);
    expect(takeRequestLink()).toBe(second.link);
    expect(takeRequestLink()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('holds the scheme form in its https form', () => {
    const { link } = connectLink();

    acceptRequestLink(`${BREAD_REQUEST_SCHEME_URL}${link.slice(BREAD_REQUEST_URL.length)}`);

    expect(nextRequestLink()).toBe(link);
  });

  it('holds at most ten links, dropping the oldest', () => {
    const links = Array.from({ length: 11 }, () => connectLink().link);
    links.forEach(acceptRequestLink);

    expect(nextRequestLink()).toBe(links[1]);
  });

  it('never holds a taken id again in this app session, even after a reload', () => {
    const { link, id } = connectLink();
    acceptRequestLink(link);
    takeRequestLink();

    __resetRequestLinksForTest();
    acceptRequestLink(link);

    expect(nextRequestLink()).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(BREAD_CONNECT_TAKEN_KEY)!)).toEqual([id]);
  });

  it('remembers the last two hundred taken ids', () => {
    const links = Array.from({ length: 201 }, () => connectLink());
    for (const { link } of links) {
      acceptRequestLink(link);
      takeRequestLink();
    }

    const taken = JSON.parse(sessionStorage.getItem(BREAD_CONNECT_TAKEN_KEY)!);
    expect(taken).toHaveLength(200);
    expect(taken[0]).toBe(links[1]!.id);
    acceptRequestLink(links[0]!.link);
    expect(nextRequestLink()).toBe(links[0]!.link);
  });

  it.each([
    ['not JSON', '{'],
    ['not a list', '{"id":1}']
  ])('reads a taken record that is %s as empty', (_name, stored) => {
    sessionStorage.setItem(BREAD_CONNECT_TAKEN_KEY, stored);
    const { link } = connectLink();

    acceptRequestLink(link);

    expect(nextRequestLink()).toBe(link);
  });

  it('keeps only the string ids of a taken record', () => {
    const { link, id } = connectLink();
    sessionStorage.setItem(BREAD_CONNECT_TAKEN_KEY, JSON.stringify([7, id]));

    acceptRequestLink(link);

    expect(nextRequestLink()).toBeNull();
  });

  it('still hands out the link when storage refuses the taken record', () => {
    const { link } = connectLink();
    acceptRequestLink(link);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(takeRequestLink()).toBe(link);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('startRequestLinkCapture', () => {
  it('holds request links the app receives and the one that launched it, listening once', async () => {
    const launch = connectLink();
    const live = connectLink();
    mockGetLaunchUrl.mockResolvedValueOnce({ url: launch.link });

    startRequestLinkCapture();
    startRequestLinkCapture();
    await flushPromises();
    const listener = mockAddListener.mock.calls[0]![1] as (event: { url: string }) => void;
    listener({ url: live.link });

    expect(mockAddListener).toHaveBeenCalledTimes(1);
    expect(mockAddListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
    expect(takeRequestLink()).toBe(launch.link);
    expect(takeRequestLink()).toBe(live.link);
  });

  it('holds nothing for a launch without a link', async () => {
    mockGetLaunchUrl.mockResolvedValueOnce({});

    startRequestLinkCapture();
    await flushPromises();

    expect(nextRequestLink()).toBeNull();
  });

  it('holds again after a restart the links it held, but none taken or older than ten minutes', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_792_000_000_000);
    try {
      const taken = connectLink();
      const stale = connectLink();
      const held = connectLink();
      acceptRequestLink(taken.link);
      expect(takeRequestLink()).toBe(taken.link);
      acceptRequestLink(stale.link);
      now.mockReturnValue(1_792_000_000_000 + 6 * 60_000);
      acceptRequestLink(held.link);

      now.mockReturnValue(1_792_000_000_000 + 11 * 60_000);
      __resetRequestLinksForTest();
      startRequestLinkCapture();
      await flushPromises();

      expect(takeRequestLink()).toBe(held.link);
      expect(nextRequestLink()).toBeNull();
      __resetRequestLinksForTest();
      startRequestLinkCapture();
      await flushPromises();
      expect(nextRequestLink()).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('warns when the listener or the launch link fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockAddListener.mockRejectedValueOnce(new Error('no bridge'));
      mockGetLaunchUrl.mockRejectedValueOnce(new Error('no bridge'));

      startRequestLinkCapture();
      await flushPromises();

      expect(warn).toHaveBeenCalledWith('[bread-connect] appUrlOpen listener failed:', expect.any(Error));
      expect(warn).toHaveBeenCalledWith('[bread-connect] getLaunchUrl failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});
