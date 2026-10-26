import { logger } from './logger';

/**
 * The server path is gone, so these tests are deliberately narrow: the logger's
 * whole contract is now "the right console sink, the message, and the caller's
 * meta when there is any".
 *
 * The removed assertions covered `censorKeys` (an Aleo `APrivateKey`/`AViewKey`
 * scrubber, formats Miden does not have), `sendLog`/`sendLogToServer`, and the
 * `localStorage['analytics']` consent gate. One of them asserted the fail-open
 * behaviour outright — "handles empty analytics localStorage … Should still call
 * since analytics is not explicitly disabled" — which is the property the
 * removal exists to eliminate, so it is not carried forward. Consent now lives
 * in `lib/settings/helpers` and is enforced in `lib/telemetry`.
 */
describe('logger', () => {
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    localStorage.clear();
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    localStorage.clear();
  });

  it('routes info to console.info', () => {
    logger.info('an info message');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('an info message');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('routes warning to console.warn', () => {
    logger.warning('a warning message');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('a warning message');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('routes error to console.error', () => {
    logger.error('an error message');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('an error message');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('forwards the caller-supplied meta to each sink', () => {
    const cause = new Error('boom');

    logger.info('info', { foo: 'bar' });
    logger.warning('warn', cause);
    logger.error('error', { errorCode: 500 });

    expect(infoSpy).toHaveBeenCalledWith('info', { foo: 'bar' });
    expect(warnSpy).toHaveBeenCalledWith('warn', cause);
    expect(errorSpy).toHaveBeenCalledWith('error', { errorCode: 500 });
  });

  it('omits the meta argument entirely when none is given', () => {
    logger.info('no meta');

    // Not `('no meta', undefined)` — that would print a bare "undefined"
    // alongside every message that has no context to add.
    expect(infoSpy.mock.calls[0]).toEqual(['no meta']);
  });

  it('forwards an explicitly null meta rather than treating it as absent', () => {
    logger.error('null meta', null);

    expect(errorSpy).toHaveBeenCalledWith('null meta', null);
  });

  it('logs synchronously, with no promise for a caller to forget to await', () => {
    // Every production call site is fire-and-forget (`logger.warning(msg, e)`),
    // which the removed `async` methods made a floating promise at each one.
    expect(logger.info('sync')).toBeUndefined();
    expect(logger.warning('sync')).toBeUndefined();
    expect(logger.error('sync')).toBeUndefined();
  });

  it('no longer exposes the removed server path', () => {
    const surface = logger as unknown as Record<string, unknown>;

    for (const removed of ['sendLog', 'sendLogToServer', 'censorKeys']) {
      expect(surface[removed]).toBeUndefined();
    }
  });

  it('does not read the legacy analytics consent key', () => {
    // The old gate keyed off this and failed open when it was absent. Nothing
    // in the logger may consult it again — `clearLegacyAnalyticsStorage()`
    // deletes it at startup, which under the old code turned the gate off.
    const getItem = jest.spyOn(Storage.prototype, 'getItem');

    logger.info('message');
    logger.warning('message');
    logger.error('message');

    expect(getItem).not.toHaveBeenCalledWith('analytics');
    getItem.mockRestore();
  });
});
