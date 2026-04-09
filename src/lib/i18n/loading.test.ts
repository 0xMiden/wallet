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
  });
});
