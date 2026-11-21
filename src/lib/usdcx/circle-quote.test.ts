// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/cctp-quote.test.ts (MIT).
import { fetchCctpBurnQuote } from './cctp';

const fetchMock = jest.fn();
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const token = '0x1111111111111111111111111111111111111111';
const options = {
  baseUrl: 'https://iris.example',
  amount: 4_000_000n,
  feeToken: token,
  destinationCaller: '0x0000000000000000000000002222222222222222222222222222222222222222',
  hookData: '0x1234',
  fast: true
} satisfies Parameters<typeof fetchCctpBurnQuote>[2];
const quote = () => ({
  signedQuote: '0x0102',
  burnAmount: '4000000',
  feeToken: token,
  feeTotalAmount: '31908',
  issuedAt: 1800000000,
  expiry: { mode: 'TIMESTAMP', expiresAt: 1800000120 }
});
function response(body: unknown, status = 200) {
  return { ok: status === 200, status, text: async () => JSON.stringify(body), json: async () => body };
}
beforeAll(() => Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock }));
afterAll(() => {
  if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
beforeEach(() => jest.resetAllMocks());

it('accepts the exact amount and token and binds the forwarded hook in the actual request', async () => {
  fetchMock.mockResolvedValue(response(quote()));
  const result = await fetchCctpBurnQuote(3, 26, options);
  expect(result.feeTotalAmount).toBe(31908n);
  expect(result.signedQuote).toBe('0x0102');
  expect(result.expiresAt).toBe(1800000120);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://iris.example/v2/quote/burn/usdc/3/26');
  expect(JSON.parse(init.body)).toEqual({
    amount: '4000000',
    feeToken: token,
    requests: [
      { type: 'PRE_FINALITY' },
      {
        type: 'FORWARD',
        params: {
          destinationCaller: options.destinationCaller,
          hookData: '0x1234'
        }
      }
    ]
  });
});

it.each([
  ['amount', { burnAmount: '4000001' }],
  ['fee token', { feeToken: '0x2222222222222222222222222222222222222222' }],
  ['missing amount', { burnAmount: undefined }],
  ['negative fee', { feeTotalAmount: '-1' }],
  ['empty signature', { signedQuote: '0x' }],
  ['odd signature', { signedQuote: '0x123' }],
  ['oversized signature', { signedQuote: `0x${'01'.repeat(8192)}` }],
  ['invalid timestamp', { expiry: { mode: 'TIMESTAMP', expiresAt: 1800000000 } }],
  ['unknown expiry', { expiry: { mode: 'ESTIMATE', expiresAt: 1800000120 } }],
  ['fractional block', { expiry: { mode: 'BLOCK_NUMBER', expiresAtBlock: 1.5 } }]
])('refuses a Circle quote with %s mismatch before exposing authorization', async (_, patch) => {
  fetchMock.mockResolvedValue(response({ ...quote(), ...patch }));
  await expect(fetchCctpBurnQuote(3, 26, options)).rejects.toThrow();
});

it('does not turn a block estimate into timestamp consent', async () => {
  fetchMock.mockResolvedValue(
    response({
      ...quote(),
      expiry: {
        mode: 'BLOCK_NUMBER',
        expiresAtBlock: 400,
        blockEstimatedAt: 1800000120
      }
    })
  );
  const result = await fetchCctpBurnQuote(3, 26, options);
  expect(result.expiresAt).toBeUndefined();
  expect(result).toMatchObject({ expiry: { mode: 'BLOCK_NUMBER', expiresAtBlock: 400 } });
});

it('refuses redirects', async () => {
  fetchMock.mockResolvedValueOnce(response({}, 302));
  await expect(fetchCctpBurnQuote(3, 26, options)).rejects.toThrow();
  expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
});

it('refuses oversized JSON, not just an oversized signature field', async () => {
  fetchMock.mockResolvedValueOnce(response({ ...quote(), padding: 'x'.repeat(262145) }));
  await expect(fetchCctpBurnQuote(3, 26, options)).rejects.toThrow();
});

it('does not expose raw Circle refusal or transport URL/account data', async () => {
  const privateData = 'https://private.example/?account=secret';
  fetchMock.mockResolvedValueOnce(response({ error: privateData, errorCode: privateData }, 422));
  const refused: unknown = await fetchCctpBurnQuote(3, 26, options).catch(error => error);
  expect(String(refused)).not.toContain(privateData);
});

it('does not expose raw transport URL/account data', async () => {
  const privateData = 'https://private.example/?account=secret';
  fetchMock.mockRejectedValueOnce(new Error(privateData));
  const unavailable: unknown = await fetchCctpBurnQuote(3, 26, options).catch(error => error);
  expect(String(unavailable)).not.toContain(privateData);
  expect(unavailable).not.toHaveProperty('cause');
});
