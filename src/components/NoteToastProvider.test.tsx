import React from 'react';

import { render } from '@testing-library/react';

import { showExtensionNotification } from 'lib/extension/notifications';
import { initNativeNotifications, showNoteReceivedNotification } from 'lib/mobile/native-notifications';
import { isExtension, isMobile } from 'lib/platform';

import { NoteToastProvider } from './NoteToastProvider';

// Mock dependencies
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isExtension: jest.fn()
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-public-key' })
}));

jest.mock('lib/miden/front/useNoteToast', () => ({
  useNoteToastMonitor: jest.fn()
}));

jest.mock('lib/mobile/native-notifications', () => ({
  initNativeNotifications: jest.fn(),
  showNoteReceivedNotification: jest.fn()
}));

jest.mock('lib/extension/notifications', () => ({
  showExtensionNotification: jest.fn()
}));

let mockStoreState = {
  isNoteToastVisible: false,
  noteToastShownAt: null as number | null,
  dismissNoteToast: jest.fn()
};

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState)
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

describe('NoteToastProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockIsExtension.mockReturnValue(false);
    mockStoreState = {
      isNoteToastVisible: false,
      noteToastShownAt: null,
      dismissNoteToast: jest.fn()
    };
  });

  it('returns null on non-mobile non-extension platforms', () => {
    const { container } = render(<NoteToastProvider />);

    expect(container.firstChild).toBeNull();
    expect(initNativeNotifications).not.toHaveBeenCalled();
  });

  it('initializes native notifications on mobile', () => {
    mockIsMobile.mockReturnValue(true);

    render(<NoteToastProvider />);

    expect(initNativeNotifications).toHaveBeenCalled();
  });

  it('does not initialize native notifications on extension', () => {
    mockIsExtension.mockReturnValue(true);

    render(<NoteToastProvider />);

    expect(initNativeNotifications).not.toHaveBeenCalled();
  });

  it('shows mobile notification when toast is visible on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    mockStoreState.isNoteToastVisible = true;
    mockStoreState.noteToastShownAt = Date.now();

    render(<NoteToastProvider />);

    expect(showNoteReceivedNotification).toHaveBeenCalledWith('noteReceivedTitle', 'noteReceivedTapToClaim');
    expect(showExtensionNotification).not.toHaveBeenCalled();
    expect(mockStoreState.dismissNoteToast).toHaveBeenCalled();
  });

  it('shows extension notification when toast is visible on extension', () => {
    mockIsExtension.mockReturnValue(true);
    mockStoreState.isNoteToastVisible = true;
    mockStoreState.noteToastShownAt = Date.now();

    render(<NoteToastProvider />);

    expect(showExtensionNotification).toHaveBeenCalledWith('noteReceivedTitle', 'noteReceivedClickToClaim');
    expect(showNoteReceivedNotification).not.toHaveBeenCalled();
    expect(mockStoreState.dismissNoteToast).toHaveBeenCalled();
  });

  it('does not show notification when toast is not visible', () => {
    mockIsMobile.mockReturnValue(true);
    mockStoreState.isNoteToastVisible = false;

    render(<NoteToastProvider />);

    expect(showNoteReceivedNotification).not.toHaveBeenCalled();
    expect(showExtensionNotification).not.toHaveBeenCalled();
  });

  it('renders null even on mobile', () => {
    mockIsMobile.mockReturnValue(true);

    const { container } = render(<NoteToastProvider />);

    expect(container.firstChild).toBeNull();
  });

  it('renders null on extension', () => {
    mockIsExtension.mockReturnValue(true);

    const { container } = render(<NoteToastProvider />);

    expect(container.firstChild).toBeNull();
  });
});
