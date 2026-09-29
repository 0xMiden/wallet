import { type TransakExpectation, checkTransakEvent, parseTransakEvent } from './transak-guard';

const EVM_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const OTHER_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

const expected: TransakExpectation = { evmAddress: EVM_ADDRESS, fiatAmount: '50' };

// SYNTHETIC fixtures, made from the field names in the Transak order payload docs. The spike replaces them with
// payloads captured from the staging widget in the iOS and Android InAppBrowser.
const SYNTHETIC_ORDER = {
  id: 'synthetic-order-id',
  walletAddress: EVM_ADDRESS,
  status: 'AWAITING_PAYMENT_FROM_USER',
  fiatCurrency: 'USD',
  cryptoCurrency: 'USDC',
  isBuyOrSell: 'BUY',
  fiatAmount: 50,
  cryptoAmount: 49.1,
  network: 'ethereum',
  partnerOrderId: '0123456789abcdef0123456789abcdef'
};

const SYNTHETIC_ORDER_CREATED_NATIVE = JSON.stringify({ eventName: 'TRANSAK_ORDER_CREATED', data: SYNTHETIC_ORDER });
const SYNTHETIC_ORDER_CREATED_WINDOW = { event_id: 'TRANSAK_ORDER_CREATED', data: SYNTHETIC_ORDER };
const SYNTHETIC_WIDGET_OPEN = { event_id: 'TRANSAK_WIDGET_OPEN', data: true };

function orderEvent(data: object, eventName = 'TRANSAK_ORDER_CREATED') {
  const event = parseTransakEvent({ event_id: eventName, data });
  if (event === null) throw new Error('fixture did not parse');
  return event;
}

describe('parseTransakEvent', () => {
  it('parses a native bridge JSON string with eventName', () => {
    expect(parseTransakEvent(SYNTHETIC_ORDER_CREATED_NATIVE)).toEqual({
      eventName: 'TRANSAK_ORDER_CREATED',
      data: expect.objectContaining({ walletAddress: EVM_ADDRESS, fiatAmount: 50 })
    });
  });

  it('parses a native bridge JSON string with event_id', () => {
    const raw = JSON.stringify(SYNTHETIC_ORDER_CREATED_WINDOW);
    expect(parseTransakEvent(raw)?.eventName).toBe('TRANSAK_ORDER_CREATED');
  });

  it('parses a window postMessage object', () => {
    expect(parseTransakEvent(SYNTHETIC_ORDER_CREATED_WINDOW)).toEqual({
      eventName: 'TRANSAK_ORDER_CREATED',
      data: expect.objectContaining({ walletAddress: EVM_ADDRESS, network: 'ethereum' })
    });
  });

  it('parses both shapes wrapped by the injected script', () => {
    expect(parseTransakEvent({ transak: SYNTHETIC_ORDER_CREATED_NATIVE })?.eventName).toBe('TRANSAK_ORDER_CREATED');
    expect(parseTransakEvent({ transak: SYNTHETIC_ORDER_CREATED_WINDOW })?.eventName).toBe('TRANSAK_ORDER_CREATED');
  });

  it('keeps an event whose data is not an object, with null data', () => {
    expect(parseTransakEvent(SYNTHETIC_WIDGET_OPEN)).toEqual({ eventName: 'TRANSAK_WIDGET_OPEN', data: null });
  });

  it('reads a numeric fiatAmount string as a number', () => {
    expect(orderEvent({ ...SYNTHETIC_ORDER, fiatAmount: '50' }).data?.fiatAmount).toBe(50);
  });

  it('reads an order nested under status', () => {
    const event = orderEvent({ status: SYNTHETIC_ORDER }, 'TRANSAK_ORDER_SUCCESSFUL');
    expect(event.data?.order?.walletAddress).toBe(EVM_ADDRESS);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['text that is not JSON', 'hello'],
    ['a JSON string of a number', '42'],
    ['an object without an event name', { data: SYNTHETIC_ORDER }],
    ['an event that is not from Transak', { event_id: 'OTHER_EVENT', data: SYNTHETIC_ORDER }],
    ['a wrapper with a number', { transak: 42 }],
    ['an event name that is a number', { eventName: 7, data: SYNTHETIC_ORDER }]
  ])('returns null for %s', (_label, raw) => {
    expect(parseTransakEvent(raw)).toBeNull();
  });
});

describe('checkTransakEvent', () => {
  it('accepts the synthetic order for the expected wallet', () => {
    expect(checkTransakEvent(orderEvent(SYNTHETIC_ORDER), expected)).toBe('ok');
  });

  it('accepts the address in another case', () => {
    expect(
      checkTransakEvent(orderEvent({ ...SYNTHETIC_ORDER, walletAddress: EVM_ADDRESS.toLowerCase() }), expected)
    ).toBe('ok');
  });

  it('refuses the synthetic order with walletAddress changed', () => {
    expect(checkTransakEvent(orderEvent({ ...SYNTHETIC_ORDER, walletAddress: OTHER_ADDRESS }), expected)).toBe(
      'mismatch'
    );
  });

  it('refuses a walletAddress that is not an address', () => {
    expect(checkTransakEvent(orderEvent({ ...SYNTHETIC_ORDER, walletAddress: 'bc1qattacker' }), expected)).toBe(
      'mismatch'
    );
  });

  it('refuses TRANSAK_ORDER_CREATED without walletAddress', () => {
    const { walletAddress: _dropped, ...order } = SYNTHETIC_ORDER;
    expect(checkTransakEvent(orderEvent(order), expected)).toBe('mismatch');
  });

  it('refuses TRANSAK_ORDER_CREATED without data', () => {
    expect(checkTransakEvent({ eventName: 'TRANSAK_ORDER_CREATED', data: null }, expected)).toBe('mismatch');
  });

  it('accepts other events without walletAddress', () => {
    expect(checkTransakEvent(parseTransakEvent(SYNTHETIC_WIDGET_OPEN) ?? { eventName: '', data: null }, expected)).toBe(
      'ok'
    );
    expect(checkTransakEvent(orderEvent({ fiatAmount: 50 }, 'TRANSAK_WIDGET_INITIALISED'), expected)).toBe('ok');
  });

  it.each([
    ['fiatAmount', { fiatAmount: 5000 }],
    ['cryptoCurrency', { cryptoCurrency: 'ETH' }],
    ['cryptoCurrencyCode', { cryptoCurrencyCode: 'USDT' }],
    ['network', { network: 'polygon' }]
  ])('refuses a changed %s', (_label, change) => {
    expect(checkTransakEvent(orderEvent({ ...SYNTHETIC_ORDER, ...change }), expected)).toBe('mismatch');
  });

  it('compares token and network without case', () => {
    const order = { ...SYNTHETIC_ORDER, cryptoCurrency: 'usdc', cryptoCurrencyCode: 'Usdc', network: 'ETHEREUM' };
    expect(checkTransakEvent(orderEvent(order), expected)).toBe('ok');
  });

  it('refuses a nested order for another wallet', () => {
    const event = orderEvent(
      { status: { ...SYNTHETIC_ORDER, walletAddress: OTHER_ADDRESS } },
      'TRANSAK_ORDER_SUCCESSFUL'
    );
    expect(checkTransakEvent(event, expected)).toBe('mismatch');
  });
});
