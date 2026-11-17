import { fetchXReserveAttestations } from 'lib/usdcx/attestation-protocol';
import { fetchCctpMessages } from 'lib/usdcx/cctp';

const fetchMock = jest.fn();
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const hash = `0x${'a'.repeat(64)}` satisfies `0x${string}`;
beforeAll(() => Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock }));
afterAll(() => {
  if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
beforeEach(() => jest.resetAllMocks());
const readers = [
  { name: 'CCTP', read: () => fetchCctpMessages(0, hash, { baseUrl: 'https://circle.example', timeoutMs: 1000 }) },
  { name: 'xReserve', read: () => fetchXReserveAttestations(hash, { baseUrl: 'https://circle.example', timeoutMs: 1000 }) }
];
it.each(readers)('bounds the entire $name status response rather than only parsed entries', async ({ read }) => {
  const body = { padding: 'x'.repeat(262145), messages: [], attestations: [] };
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
  await expect(read()).rejects.toThrow();
});
it.each(readers)('never follows $name redirects or exposes upstream URL/account exception data', async ({ read }) => {
  fetchMock.mockRejectedValue(new Error('https://private.example/?account=secret'));
  const error: unknown = await read().catch(caught => caught);
  expect(String(error)).not.toContain('private.example');
  expect(error).not.toHaveProperty('cause');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
});
it.each(readers)('keeps the original $name body timeout active until the read ends', async ({ read }) => {
  jest.useFakeTimers();
  try {
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => ({ ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private raw body error')))) }));
    const result = read().catch(error => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(String(await result)).not.toContain('private raw body error');
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
