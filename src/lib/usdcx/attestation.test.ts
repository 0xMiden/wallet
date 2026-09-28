import { fetchXReserveAttestations, findAttestationForDomain, XReserveAttestation } from './attestation';
import { XRESERVE_ATTESTATION_API } from './constant';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

const TX_HASH = `0x${'a'.repeat(64)}` as const;

const entry = (overrides: Record<string, unknown> = {}) => ({
  payload: '0x1234',
  messageHash: `0x${'b'.repeat(64)}`,
  attestation: '0xabcd',
  remoteDomain: 10001,
  ...overrides
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('fetchXReserveAttestations', () => {
  it('queries the attestations endpoint by transaction hash', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await fetchXReserveAttestations(TX_HASH);

    expect(fetchMock).toHaveBeenCalledWith(
      `${XRESERVE_ATTESTATION_API}/v1/attestations?txHash=${TX_HASH}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('accepts a custom base URL', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await fetchXReserveAttestations(TX_HASH, { baseUrl: 'https://example.test' });

    expect(fetchMock.mock.calls[0][0]).toBe(`https://example.test/v1/attestations?txHash=${TX_HASH}`);
  });

  // Circle answers an unknown or not-yet-signed hash with HTTP 200 and an empty list.
  it('returns an empty list before Circle signs', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([]);
  });

  it('parses a signed attestation', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('accepts a numeric-string remote domain', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [entry({ remoteDomain: '10007' })] }));

    const parsed = await fetchXReserveAttestations(TX_HASH);
    expect(parsed.map(entry => entry.remoteDomain)).toEqual([10007]);
  });

  it.each([
    ['a non-hex payload', entry({ payload: 'nope' })],
    ['a missing signature', entry({ attestation: undefined })],
    ['a non-numeric domain', entry({ remoteDomain: 'canton' })],
    ['a non-object entry', 'garbage']
  ])('drops an entry with %s', async (_label, malformed) => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [malformed, entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('returns an empty list when the body has no attestations array', async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchXReserveAttestations(TX_HASH)).rejects.toThrow('HTTP 500');
  });

  it('aborts a request that never answers', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    const pending = fetchXReserveAttestations(TX_HASH, { timeoutMs: 1000 });
    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('findAttestationForDomain', () => {
  const list: XReserveAttestation[] = [
    { payload: '0x01', messageHash: `0x${'1'.repeat(64)}`, attestation: '0x0a', remoteDomain: 10001 },
    { payload: '0x02', messageHash: `0x${'2'.repeat(64)}`, attestation: '0x0b', remoteDomain: 10007 }
  ];

  it('returns the attestation for the requested domain', () => {
    expect(findAttestationForDomain(list, 10007)?.payload).toBe('0x02');
  });

  it('ignores attestations for other domains', () => {
    expect(findAttestationForDomain(list, 10005)).toBeUndefined();
  });
});
