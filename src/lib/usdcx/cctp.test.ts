import { fetchAttestedCctpMessage, fetchCctpMessages } from './cctp';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

const TX_HASH = `0x${'a'.repeat(64)}` as const;
const BASE_URL = 'https://iris.test';

const entry = (overrides: Record<string, unknown> = {}) => ({
  message: '0x1234',
  attestation: '0xabcd',
  status: 'complete',
  eventNonce: '0x01',
  ...overrides
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fetchCctpMessages', () => {
  it('queries the messages endpoint by source domain and transaction hash', async () => {
    fetchMock.mockResolvedValue(okResponse({ messages: [] }));

    await fetchCctpMessages(6, TX_HASH, { baseUrl: BASE_URL });

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/v2/messages/6?transactionHash=${TX_HASH}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  // Iris answers 404 until it has indexed the burn.
  it('reads a 404 as no messages yet', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    await expect(fetchCctpMessages(6, TX_HASH, { baseUrl: BASE_URL })).resolves.toEqual([]);
  });

  it('fails on any other HTTP error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await expect(fetchCctpMessages(6, TX_HASH, { baseUrl: BASE_URL })).rejects.toThrow('HTTP 503');
  });

  it('keeps pending and complete entries and drops malformed ones', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        messages: [
          entry(),
          entry({ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }),
          entry({ status: 'weird' }),
          entry({ attestation: 'nope' }),
          'junk'
        ]
      })
    );

    const messages = await fetchCctpMessages(6, TX_HASH, { baseUrl: BASE_URL });

    expect(messages).toEqual([
      { message: '0x1234', attestation: '0xabcd', status: 'complete', eventNonce: '0x01' },
      { message: '0x', attestation: 'PENDING', status: 'pending_confirmations', eventNonce: '0x01' }
    ]);
  });
});

describe('fetchAttestedCctpMessage', () => {
  it('makes no request for a value that is not a transaction hash', async () => {
    await expect(fetchAttestedCctpMessage(6, 'not-a-hash', { baseUrl: BASE_URL })).resolves.toBeUndefined();
    await expect(fetchAttestedCctpMessage(6, undefined, { baseUrl: BASE_URL })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is undefined while Circle has not signed', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ messages: [entry({ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' })] })
    );

    await expect(fetchAttestedCctpMessage(6, TX_HASH, { baseUrl: BASE_URL })).resolves.toBeUndefined();
  });

  it('returns the message and proof the executor takes once Circle signed', async () => {
    fetchMock.mockResolvedValue(okResponse({ messages: [entry()] }));

    await expect(fetchAttestedCctpMessage(6, TX_HASH, { baseUrl: BASE_URL })).resolves.toEqual({
      message: '0x1234',
      attestation: '0xabcd'
    });
  });
});
