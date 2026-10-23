/**
 * @jest-environment node
 */
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';

describe('mainnet 1Click service origin fetcher', () => {
  it('adds only the exact extension origin to the configured service requests', async () => {
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response('{}'));
    const originFetch = createMainnetOneClickOriginFetcher(
      'https://1click.example/api',
      'abcdefghijklmnopabcdefghijklmnop',
      fetcher
    );

    await originFetch('https://1click.example/api/v0/tokens', { headers: { Accept: 'application/json' } });
    await originFetch('https://raw.githubusercontent.com/0xMiden/wallet-config/mainnet.json');

    const firstHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(firstHeaders.get('Origin')).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });

  it('rejects malformed extension origins', () => {
    expect(() => createMainnetOneClickOriginFetcher('https://1click.example', 'not-an-extension-id')).toThrow('Invalid wallet extension id');
  });

  it('validates origin arguments before resolving the default fetch implementation', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let fetchReads = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => {
        fetchReads += 1;
        return descriptor?.value;
      }
    });
    try {
      expect(() => createMainnetOneClickOriginFetcher('https://1click.example', 'invalid')).toThrow('Invalid wallet extension id');
      expect(fetchReads).toBe(0);
      const fetchWithOrigin = createMainnetOneClickOriginFetcher('https://1click.example', 'abcdefghijklmnopabcdefghijklmnop');
      expect(fetchReads).toBe(0);
      expect(typeof fetchWithOrigin).toBe('function');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
      else Reflect.deleteProperty(globalThis, 'fetch');
    }
  });
});
