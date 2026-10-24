import { findPowNonce } from './faucet-pow-solver';

jest.mock('./faucet-pow-solver', () => ({ findPowNonce: jest.fn() }));
const solveMock = jest.mocked(findPowNonce);

describe('faucet PoW worker', () => {
  let receive: (event: MessageEvent) => Promise<void>;
  let post: jest.SpyInstance;
  beforeEach(() => {
    jest.resetModules();
    solveMock.mockReset();
    const listen = jest.spyOn(globalThis, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') receive = listener as unknown as typeof receive;
    });
    post = jest.spyOn(globalThis, 'postMessage').mockImplementation(() => undefined);
    require('./faucet-pow-worker');
    listen.mockRestore();
  });
  afterEach(() => post.mockRestore());

  it('returns the solved nonce', async () => {
    // resetModules gives the worker its own reference to this mock module.
    const solver = jest.mocked(require('./faucet-pow-solver').findPowNonce);
    solver.mockResolvedValue(123);
    await receive(new MessageEvent('message', { data: { challengeHex: '00', target: 1n } }));
    expect(solver).toHaveBeenCalledWith('00', 1n);
    expect(post).toHaveBeenCalledWith({ nonce: 123 });
  });

  it.each([new Error('hash failed'), 'hash failed'])('returns a hash failure', async error => {
    const solver = jest.mocked(require('./faucet-pow-solver').findPowNonce);
    solver.mockRejectedValue(error);
    await receive(new MessageEvent('message', { data: { challengeHex: '00', target: 1n } }));
    expect(post).toHaveBeenCalledWith({ error: 'hash failed' });
  });
});
