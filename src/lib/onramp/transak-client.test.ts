/**
 * @jest-environment node
 */
import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { TransakSessionError, createTransakBuySession } from './transak-client';
import { buildChallengeMessage } from './transak-message';

const mockSignMessage = jest.fn();

jest.mock('lib/epoch/evm-account', () => ({
  buildVaultEvmWalletClient: jest.fn((_publicKey: string, address: string) => ({
    account: { address, type: 'local' },
    signMessage: mockSignMessage
  }))
}));

const EVM_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW_SECONDS = 1_790_000_000;
const EXPIRES_AT = NOW_SECONDS + 300;
const SIGNATURE = '0xsigned';
const WIDGET_URL = 'https://global-stg.transak.com?apiKey=key&sessionId=session';

const signMessage = mockSignMessage;
const mockBuildClient = jest.mocked(buildVaultEvmWalletClient);
const fetchMock = jest.fn();

interface WidgetParamsFixture {
  referrerDomain?: string;
  walletAddress?: string;
  disableWalletAddressForm?: boolean;
  fiatAmount?: number;
  fiatCurrency?: string;
  cryptoCurrencyCode?: string;
  network?: string;
  productsAvailed?: string;
  partnerOrderId?: string;
}

function goodWidgetParams(): WidgetParamsFixture {
  return {
    referrerDomain: 'wallet.miden.io',
    walletAddress: EVM_ADDRESS,
    disableWalletAddressForm: true,
    fiatAmount: 50,
    fiatCurrency: 'USD',
    cryptoCurrencyCode: 'USDC',
    network: 'ethereum',
    productsAvailed: 'BUY',
    partnerOrderId: NONCE
  };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function challengeBody(message?: string): object {
  return {
    nonce: NONCE,
    expiresAt: EXPIRES_AT,
    message:
      message ?? buildChallengeMessage({ fiatAmount: '50', address: EVM_ADDRESS, nonce: NONCE, expiresAt: EXPIRES_AT })
  };
}

function mockServer(options: { challenge?: object; widgetUrl?: string; widgetParams?: WidgetParamsFixture } = {}) {
  fetchMock.mockResolvedValueOnce(jsonResponse(options.challenge ?? challengeBody())).mockResolvedValueOnce(
    jsonResponse({
      widgetUrl: options.widgetUrl ?? WIDGET_URL,
      widgetParams: options.widgetParams ?? goodWidgetParams()
    })
  );
}

const input = {
  apiUrl: 'https://backend.example/',
  midenAccountPublicKey: 'miden-pk',
  evmAddress: EVM_ADDRESS,
  fiatAmount: '50'
} satisfies Parameters<typeof createTransakBuySession>[0];

async function expectFailure(reason: 'request-failed' | 'mismatch'): Promise<void> {
  const error = await createTransakBuySession(input).then(
    () => null,
    (caught: Error) => caught
  );
  expect(error).toBeInstanceOf(TransakSessionError);
  expect(error instanceof TransakSessionError ? error.reason : null).toBe(reason);
}

describe('createTransakBuySession', () => {
  let dateNow: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
    fetchMock.mockReset();
    global.fetch = fetchMock;
    signMessage.mockResolvedValue(SIGNATURE);
  });

  afterEach(() => {
    dateNow.mockRestore();
  });

  it('signs the local message and returns the widget URL', async () => {
    mockServer();

    const session = await createTransakBuySession(input);

    expect(session).toEqual({ widgetUrl: WIDGET_URL, partnerOrderId: NONCE });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://backend.example/transak/challenge',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ evmAddress: EVM_ADDRESS, fiatAmount: '50' }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://backend.example/transak/session',
      expect.objectContaining({ body: JSON.stringify({ nonce: NONCE, signature: SIGNATURE }) })
    );
    expect(mockBuildClient).toHaveBeenCalledWith('miden-pk', EVM_ADDRESS);
    expect(signMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: buildChallengeMessage({ fiatAmount: '50', address: EVM_ADDRESS, nonce: NONCE, expiresAt: EXPIRES_AT })
      })
    );
  });

  it('refuses a message that the server changed, before it signs', async () => {
    mockServer({ challenge: challengeBody('Sign this for 5000 USD') });

    await expectFailure('mismatch');
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a message for another address, before it signs', async () => {
    mockServer({
      challenge: challengeBody(
        buildChallengeMessage({ fiatAmount: '50', address: OTHER_ADDRESS, nonce: NONCE, expiresAt: EXPIRES_AT })
      )
    });

    await expectFailure('mismatch');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('refuses an expired challenge', async () => {
    const expiresAt = NOW_SECONDS - 1;
    mockServer({
      challenge: {
        nonce: NONCE,
        expiresAt,
        message: buildChallengeMessage({ fiatAmount: '50', address: EVM_ADDRESS, nonce: NONCE, expiresAt })
      }
    });

    await expectFailure('mismatch');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('refuses a challenge that expires too late', async () => {
    const expiresAt = NOW_SECONDS + 3600;
    mockServer({
      challenge: {
        nonce: NONCE,
        expiresAt,
        message: buildChallengeMessage({ fiatAmount: '50', address: EVM_ADDRESS, nonce: NONCE, expiresAt })
      }
    });

    await expectFailure('mismatch');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('refuses a mirrored walletAddress for another address', async () => {
    mockServer({ widgetParams: { ...goodWidgetParams(), walletAddress: OTHER_ADDRESS } });
    await expectFailure('mismatch');
  });

  it('accepts a mirrored walletAddress in another case', async () => {
    mockServer({ widgetParams: { ...goodWidgetParams(), walletAddress: EVM_ADDRESS.toLowerCase() } });
    await expect(createTransakBuySession(input)).resolves.toEqual({ widgetUrl: WIDGET_URL, partnerOrderId: NONCE });
  });

  it.each([
    'walletAddress',
    'disableWalletAddressForm',
    'fiatAmount',
    'fiatCurrency',
    'cryptoCurrencyCode',
    'network',
    'productsAvailed',
    'partnerOrderId'
  ] satisfies (keyof WidgetParamsFixture)[])('refuses a missing mirrored %s', async field => {
    const widgetParams = goodWidgetParams();
    delete widgetParams[field];
    mockServer({ widgetParams });
    await expectFailure('mismatch');
  });

  it('refuses a mirrored disableWalletAddressForm false', async () => {
    mockServer({ widgetParams: { ...goodWidgetParams(), disableWalletAddressForm: false } });
    await expectFailure('mismatch');
  });

  it('refuses a mirrored partnerOrderId that is not the nonce', async () => {
    mockServer({ widgetParams: { ...goodWidgetParams(), partnerOrderId: 'ffffffffffffffffffffffffffffffff' } });
    await expectFailure('mismatch');
  });

  it.each<[string, WidgetParamsFixture]>([
    ['amount', { fiatAmount: 5000 }],
    ['currency', { fiatCurrency: 'EUR' }],
    ['token', { cryptoCurrencyCode: 'ETH' }],
    ['network', { network: 'polygon' }],
    ['product', { productsAvailed: 'SELL' }]
  ])('refuses a changed %s', async (_label, change) => {
    mockServer({ widgetParams: { ...goodWidgetParams(), ...change } });
    await expectFailure('mismatch');
  });

  it.each([
    'https://evil.example/?apiKey=key',
    'https://transak.com.evil.example/',
    'http://global.transak.com/',
    'not a url'
  ])('refuses the widget URL %s', async widgetUrl => {
    mockServer({ widgetUrl });
    await expectFailure('mismatch');
  });

  it('gives request-failed on HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    await expectFailure('request-failed');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('gives request-failed when the backend is not reachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expectFailure('request-failed');
  });

  it('gives request-failed on an invalid challenge body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonce: 'short', expiresAt: EXPIRES_AT, message: 'x' }));
    await expectFailure('request-failed');
  });
});
