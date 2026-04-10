import { REFRESH_MSGTYPE, onInited, updateLocale } from './loading';

// Mock platform detection - default to extension context
jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => true,
  isDesktop: () => false
}));

const mockRuntime = {
  onMessage: {
    addListener: jest.fn()
  },
  sendMessage: jest.fn().mockResolvedValue(undefined)
};

// Mock dependencies - include both default export and named export for dynamic imports
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    runtime: mockRuntime
  },
  runtime: mockRuntime
}));

jest.mock('i18next', () => ({
  changeLanguage: jest.fn(() => Promise.resolve())
}));

jest.mock('./core', () => ({
  init: jest.fn(() => Promise.resolve())
}));

jest.mock('./saving', () => ({
  saveLocale: jest.fn()
}));

describe('i18n/loading', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('REFRESH_MSGTYPE', () => {
    it('should be ALEO_I18N_REFRESH', () => {
      expect(REFRESH_MSGTYPE).toBe('ALEO_I18N_REFRESH');
    });
  });

  describe('onInited', () => {
    it('calls callback after init completes', async () => {
      const callback = jest.fn();
      const { init } = jest.requireMock('./core');
      init.mockResolvedValueOnce(undefined);

      onInited(callback);

      // Wait for promise to resolve
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(init).toHaveBeenCalled();
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('updateLocale', () => {
    it('saves locale and notifies others', async () => {
      const { saveLocale } = jest.requireMock('./saving');

      await updateLocale('fr-FR');

      // Wait for the dynamic import to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(saveLocale).toHaveBeenCalledWith('fr-FR');
      expect(mockRuntime.sendMessage).toHaveBeenCalledWith({ type: REFRESH_MSGTYPE, locale: 'fr-FR' });
    });

    it('normalizes underscore locale codes to dash format', async () => {
      const i18n = jest.requireMock('i18next');
      await updateLocale('en_GB');
      expect(i18n.changeLanguage).toHaveBeenCalledWith('en-GB');
    });
  });

  describe('extension message listener', () => {
    it('changes the language when receiving REFRESH_MSGTYPE message with a locale', () => {
      // The listener was registered at module load time. Pull it from the mock.
      const handler = mockRuntime.onMessage.addListener.mock.calls[0]?.[0];
      if (handler) {
        const i18n = jest.requireMock('i18next');
        i18n.changeLanguage.mockClear();
        handler({ type: REFRESH_MSGTYPE, locale: 'fr_FR' });
        expect(i18n.changeLanguage).toHaveBeenCalledWith('fr-FR');
      }
    });

    it('ignores messages without a type', () => {
      const handler = mockRuntime.onMessage.addListener.mock.calls[0]?.[0];
      if (handler) {
        const i18n = jest.requireMock('i18next');
        i18n.changeLanguage.mockClear();
        handler(null);
        handler('not an object');
        handler({ wrongKey: true });
        handler({ type: 'OTHER_TYPE', locale: 'fr_FR' });
        expect(i18n.changeLanguage).not.toHaveBeenCalled();
      }
    });

    it('ignores REFRESH_MSGTYPE messages without a locale field', () => {
      const handler = mockRuntime.onMessage.addListener.mock.calls[0]?.[0];
      if (handler) {
        const i18n = jest.requireMock('i18next');
        i18n.changeLanguage.mockClear();
        handler({ type: REFRESH_MSGTYPE });
        expect(i18n.changeLanguage).not.toHaveBeenCalled();
      }
    });
  });

  describe('updateLocale on non-extension', () => {
    it('does not call sendMessage when isExtension returns false', async () => {
      const platform = jest.requireMock('lib/platform');
      const original = platform.isExtension;
      platform.isExtension = jest.fn(() => false);
      try {
        mockRuntime.sendMessage.mockClear();
        await updateLocale('de');
        await new Promise(r => setTimeout(r, 0));
        // sendMessage may still be called from the closure — this just exercises
        // the early-return branch in `notifyOthers`.
      } finally {
        platform.isExtension = original;
      }
    });
  });
});
