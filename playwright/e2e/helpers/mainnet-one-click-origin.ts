export function createMainnetOneClickOriginFetcher(
  serviceUrl: string,
  extensionId: string,
  fetcher: typeof fetch = fetch
): typeof fetch {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid wallet extension id');
  const serviceOrigin = new URL(serviceUrl).origin;
  const extensionOrigin = `chrome-extension://${extensionId}`;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url);
    if (url.origin !== serviceOrigin) return fetcher(input, init);
    const headers = new Headers(init?.headers);
    headers.set('Origin', extensionOrigin);
    return fetcher(input, { ...init, headers });
  };
}
