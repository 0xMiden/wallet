export function createMainnetOneClickOriginFetcher(
  serviceUrl: string,
  extensionId: string,
  fetcher?: typeof fetch
): typeof fetch {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid wallet extension id');
  const serviceOrigin = new URL(serviceUrl).origin;
  const extensionOrigin = `chrome-extension://${extensionId}`;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const sourceFetch = fetcher ?? globalThis.fetch;
    if (typeof sourceFetch !== 'function') throw new Error('Fetch is unavailable');
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
    if (url.origin !== serviceOrigin) return sourceFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set('Origin', extensionOrigin);
    return sourceFetch(input, { ...init, headers });
  };
}
