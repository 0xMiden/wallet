import {
  CctpQuoteRefusedError,
  fetchAttestedCctpMessage,
  fetchCctpBurnQuote,
  fetchCctpMessages,
  isCctpForwardFailed
} from './cctp';

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
      attestation: '0xabcd',
      forwardState: undefined,
      forwardTxHash: undefined
    });
  });

  it('carries the forwarding state and the destination hash once Circle forwarded', async () => {
    const forwardTxHash = `0x${'f'.repeat(64)}`;
    fetchMock.mockResolvedValue(okResponse({ messages: [entry({ forwardState: 'COMPLETE', forwardTxHash })] }));

    await expect(fetchAttestedCctpMessage(6, TX_HASH, { baseUrl: BASE_URL })).resolves.toEqual({
      message: '0x1234',
      attestation: '0xabcd',
      forwardState: 'COMPLETE',
      forwardTxHash
    });
  });
});

describe('isCctpForwardFailed', () => {
  it('reads only a failed, rejected, errored or cancelled state as given up', () => {
    expect(isCctpForwardFailed(undefined)).toBe(false);
    expect(isCctpForwardFailed('PENDING')).toBe(false);
    expect(isCctpForwardFailed('COMPLETE')).toBe(false);
    expect(isCctpForwardFailed('FAILED')).toBe(true);
    expect(isCctpForwardFailed('forward_rejected')).toBe(true);
  });
});

describe('fetchCctpBurnQuote', () => {
  const options = {
    baseUrl: BASE_URL,
    amount: 4_000_000n,
    feeToken: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as const,
    destinationCaller: `0x${'0'.repeat(24)}${'e'.repeat(40)}` as const,
    hookData: '0xabcdef' as const,
    fast: true
  };

  it('posts the guide-shaped request and reads the signed quote, the fee and the expiry', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        signedQuote: '0x0102',
        feeTotalAmount: '31908',
        expiry: { mode: 'TIMESTAMP', expiresAt: 1791584030 }
      })
    );

    await expect(fetchCctpBurnQuote(3, 26, options)).resolves.toEqual({
      signedQuote: '0x0102',
      feeTotalAmount: 31_908n,
      expiresAt: 1791584030
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v2/quote/burn/usdc/3/26`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      amount: '4000000',
      feeToken: options.feeToken,
      requests: [
        { type: 'PRE_FINALITY' },
        { type: 'FORWARD', params: { destinationCaller: options.destinationCaller, hookData: options.hookData } }
      ]
    });
  });

  it('asks for the forward fee only when fast is off', async () => {
    fetchMock.mockResolvedValue(okResponse({ signedQuote: '0x0102', feeTotalAmount: '31388' }));

    await fetchCctpBurnQuote(3, 26, { ...options, fast: false });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).requests).toEqual([
      { type: 'FORWARD', params: { destinationCaller: options.destinationCaller, hookData: options.hookData } }
    ]);
  });

  it("surfaces Circle's refusal with its error code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ errorCode: 'UNSUPPORTED_WORKFLOW', error: 'Handler is not configured for ARC' })
    });

    const error: unknown = await fetchCctpBurnQuote(3, 26, options).catch(caught => caught);

    expect(error).toBeInstanceOf(CctpQuoteRefusedError);
    expect(error).toMatchObject({ errorCode: 'UNSUPPORTED_WORKFLOW', message: 'Handler is not configured for ARC' });
  });

  it('rejects a response without a signed quote', async () => {
    fetchMock.mockResolvedValue(okResponse({ feeTotalAmount: '1' }));

    await expect(fetchCctpBurnQuote(3, 26, options)).rejects.toThrow('missing the signed quote');
  });
});
