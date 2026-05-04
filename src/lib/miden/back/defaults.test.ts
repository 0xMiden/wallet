import { isExtension } from 'lib/platform';

import { getIntercom, intercom, PublicError } from './defaults';

jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

jest.mock('lib/intercom/server', () => ({
  IntercomServer: jest.fn().mockImplementation(() => ({
    onRequest: jest.fn(),
    broadcast: jest.fn(),
    hasClients: jest.fn().mockReturnValue(true)
  }))
}));

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

describe('defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getIntercom', () => {
    it('throws error when not in extension context', () => {
      mockIsExtension.mockReturnValue(false);

      expect(() => getIntercom()).toThrow('IntercomServer is only available in extension context');
    });

    it('returns IntercomServer instance when in extension context', () => {
      mockIsExtension.mockReturnValue(true);

      const result = getIntercom();

      expect(result).toBeDefined();
      expect(result!.onRequest).toBeDefined();
      expect(result!.broadcast).toBeDefined();
    });

    it('returns same instance on subsequent calls', () => {
      mockIsExtension.mockReturnValue(true);

      const result1 = getIntercom();
      const result2 = getIntercom();

      expect(result1).toBe(result2);
    });
  });

  describe('intercom object', () => {
    beforeEach(() => {
      // Reset module to clear singleton
      jest.resetModules();
    });

    it('instance getter returns IntercomServer', async () => {
      jest.doMock('lib/platform', () => ({
        isExtension: jest.fn().mockReturnValue(true)
      }));
      jest.doMock('lib/intercom/server', () => ({
        IntercomServer: jest.fn().mockImplementation(() => ({
          onRequest: jest.fn(),
          broadcast: jest.fn()
        }))
      }));

      const { intercom: lazyIntercom } = await import('./defaults');

      expect(lazyIntercom.instance).toBeDefined();
    });

    it('onRequest delegates to getIntercom', () => {
      mockIsExtension.mockReturnValue(true);

      const callback = jest.fn();
      intercom.onRequest(callback);

      const server = getIntercom();
      expect(server!.onRequest).toHaveBeenCalledWith(callback);
    });

    it('broadcast delegates to getIntercom', () => {
      mockIsExtension.mockReturnValue(true);

      const message = { type: 'test' };
      intercom.broadcast(message as any);

      const server = getIntercom();
      expect(server!.broadcast).toHaveBeenCalledWith(message);
    });

    it('hasClients delegates to getIntercom', () => {
      mockIsExtension.mockReturnValue(true);

      const result = intercom.hasClients();

      const server = getIntercom();
      expect(server!.hasClients).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('PublicError', () => {
    it('is an instance of Error', () => {
      const error = new PublicError('test error');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(PublicError);
      expect(error.message).toBe('test error');
    });
  });
});
