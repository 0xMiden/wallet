import React from 'react';

import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { fireEvent, waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { hapticLight } from 'lib/mobile/haptics';

import { Receive } from './Receive';

// Pending (claimable) notes moved to their own `/pending-notes` page — see
// Pending.test.tsx for the claim-flow coverage. Receive is now address-only.

// Echoes the interpolated values so a test can tell which network reached the copy.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, p?: Record<string, string>) => (p ? `${key}:${p.network ?? ''}:${p.address ?? ''}` : key)
  })
}));

jest.mock('@capacitor/share', () => ({
  Share: { share: jest.fn() }
}));

jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: jest.fn() }
}));

// The canonical CopyButton (AddressTab's tap-to-copy address) writes through
// `@capacitor/clipboard`, which jsdom has no native implementation for; mock it the same way
// CopyButton.test.tsx does so the copied-feedback test below resolves deterministically.
const mockClipboardWrite = jest.fn().mockResolvedValue(undefined);
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: false, sidePanel: false })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {
    Add: 'Add',
    Checkmark: 'Checkmark',
    CopyNew: 'CopyNew',
    CrossChain: 'CrossChain',
    Share: 'Share',
    WarningFill: 'WarningFill'
  }
}));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

jest.mock('app/templates/EvmConnectModal', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('app/pages/BridgeDeposit', () => ({
  __esModule: true,
  default: () => <div data-testid="bridge-deposit" />
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    title
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    title?: string;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Ghost: 'ghost', Primary: 'primary', Secondary: 'secondary' }
}));

const mockQRCodeProps = jest.fn();
// A Blob sends Share down the branches that attach the QR image, the ones real
// devices take; null keeps it on the text-only fallbacks.
let mockQrBlob: Blob | null = null;
// Set to make rendering the QR image fail; the share then goes out text-only.
let mockQrError: Error | null = null;
jest.mock('components/QRCode', () => ({
  QRCode: React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    mockQRCodeProps(props);
    React.useImperativeHandle(ref, () => ({
      getImageBlob: async () => {
        if (mockQrError) throw mockQrError;
        return mockQrBlob;
      }
    }));
    return null;
  })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-account-123' })
}));

const mockIsMobile = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile(),
  isExtension: () => false
}));

jest.mock('lib/feature-flags', () => ({
  ...jest.requireActual('lib/feature-flags'),
  isBridgeDepositEnabled: () => true
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// One copy spy for every render, so a test can see the fallback fire.

jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({ address: undefined, connected: false })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr?.slice(0, 8) || ''
}));

describe('Receive - Address', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockQRCodeProps.mockClear();
    mockQrBlob = null;
    mockQrError = null;
    mockClipboardWrite.mockClear();
    mockIsMobile.mockReturnValue(false);
    jest.mocked(hapticLight).mockClear();
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  const renderReceive = async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(<Receive />);
    });
    return testContainer;
  };

  it('renders the account address', async () => {
    const container = await renderReceive();

    const full = container.querySelector('[data-testid="receive-address-full"]');
    expect(full?.textContent).toBe('test-account-123');
  });

  it('shows "copied" for a beat after tapping the address, then reverts to the truncated address', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const container = await renderReceive();
    const copyButton = container.querySelector('[data-testid="receive-copy-address"]')!;

    // The address is a full-width 44px pill on `fill`, aligned with the notice and actions.
    expect(copyButton).toHaveClass('h-11', 'w-full', 'rounded-full', 'bg-fill', 'text-ink');
    expect(copyButton.textContent).toBe('test-acc');

    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'test-account-123' });
    expect(copyButton.textContent).toBe('copied');

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(copyButton.textContent).toBe('test-acc');

    jest.useRealTimers();
  });

  it('warns about test funds in a warning Notice before the share and bridge actions (#875)', async () => {
    const container = await renderReceive();

    const warning = container.querySelector('[data-testid="receive-test-funds-warning"]')!;
    // The shared Notice: a tinted note on tokens, no dashed border, and the body alone (the
    // network chip above already says which network).
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning).toHaveClass('bg-status-pending/10', 'rounded-2xl');
    expect(warning.className).not.toContain('border-dashed');
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('receiveTestFundsBody:testnet:');
    expect(warning.querySelector('[data-slot="icon"]')).not.toBeNull();
    const shareButton = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'share')!;
    const crossChain = container.querySelector('[data-testid="receive-cross-chain"]')!;
    expect(warning.compareDocumentPosition(shareButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(warning.compareDocumentPosition(crossChain)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders Share and Cross-chain as rows of one ListGroup, with one haptic per tap', async () => {
    const container = await renderReceive();

    const actions = container.querySelector('[data-testid="receive-actions"]')!;
    expect(actions).toHaveClass('rounded-2xl', 'bg-fill');
    const share = actions.querySelector('[data-testid="receive-share"]')!;
    const crossChain = actions.querySelector('[data-testid="receive-cross-chain"]')!;
    expect(share.tagName).toBe('BUTTON');
    expect(crossChain.tagName).toBe('BUTTON');
    expect(share.querySelector('[data-slot="title"]')?.textContent).toBe('share');
    expect(crossChain.querySelector('[data-slot="title"]')?.textContent).toBe('crossChain');
    // Share opens the system sheet in place; only the cross-chain row goes somewhere.
    expect(share.querySelector('[data-slot="chevron"]')).toBeNull();
    expect(crossChain.querySelector('[data-slot="chevron"]')).not.toBeNull();
    // No label is sized by hand any more (the 40px `text-[2.5rem]` spans).
    expect(container.querySelector('[class*="text-[2.5rem]"]')).toBeNull();

    await act(async () => {
      fireEvent.click(crossChain);
    });
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('names the network in a NetworkChip and keeps the caption to the shared QR image', async () => {
    const container = await renderReceive();

    expect(container.querySelector('[data-testid="receive-network"]')?.textContent).toBe('qrNetworkCaption:testnet:');
    expect(mockQRCodeProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ caption: 'qrNetworkCaption:testnet:', size: 300 })
    );
  });

  it('sizes the QR from the height the layout leaves, square and capped, instead of scrolling', async () => {
    const container = await renderReceive();

    const slot = container.querySelector('[data-testid="receive-qr-slot"]')!;
    expect(slot).toHaveClass('relative', 'flex-1', 'min-h-40', 'w-full');
    const frame = container.querySelector('[data-testid="receive-qr-frame"]')!;
    expect(frame).toHaveClass('aspect-square', 'h-full', 'max-h-72', 'max-w-full');
    // The QR block grows into the free height; the notice and actions keep their own.
    expect(container.querySelector('[data-testid="receive-qr-block"]')).toHaveClass('flex-1');
    // One column with the 16px gutter, clearing the floating tab bar off mobile.
    const column = slot.closest('[data-testid="receive-qr-block"]')!.parentElement!;
    expect(column).toHaveClass('flex', 'flex-col', 'min-h-full', 'px-4', 'pt-4', 'pb-20');
  });

  it('clears the docked tab bar on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    const container = await renderReceive();

    const column = container.querySelector('[data-testid="receive-qr-block"]')!.parentElement!;
    expect(column).toHaveClass('pb-18');
    expect(column).not.toHaveClass('pb-20');
  });

  it('does not render a pending tab switcher', async () => {
    const container = await renderReceive();

    expect(container.querySelector('[data-testid="receive-address-full"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="receive-tab-pending"]')).toBeNull();
  });

  describe('network naming (#875)', () => {
    const share = jest.fn();
    const QR_FILE_URI = 'file:///cache/miden-address.png';

    beforeEach(() => {
      share.mockReset().mockResolvedValue(undefined);
      jest.mocked(Share.share).mockClear();
      jest.mocked(Filesystem.writeFile).mockReset().mockResolvedValue({ uri: QR_FILE_URI });
      Object.defineProperty(navigator, 'share', { value: share, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    });

    afterEach(() => {
      delete (navigator as { share?: unknown }).share;
      delete (navigator as { canShare?: unknown }).canShare;
    });

    const clickShare = async (container: HTMLElement) => {
      const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'share');
      await act(async () => {
        button!.click();
      });
    };

    it('names the effective network in the warning and the QR caption', async () => {
      mockNetworkKey = 'devnet';
      const container = await renderReceive();

      const warning = container.querySelector('[data-testid="receive-test-funds-warning"]');
      expect(warning?.textContent).toContain('receiveTestFundsBody:devnet');
      expect(mockQRCodeProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ caption: 'qrNetworkCaption:devnet:' })
      );
    });

    it('shows no test-network copy on mainnet', async () => {
      mockNetworkKey = null;
      const container = await renderReceive();

      // The QR still renders on mainnet; only the test-network copy goes away.
      expect(mockQRCodeProps).toHaveBeenCalled();
      expect(container.querySelector('[data-testid="receive-test-funds-warning"]')).toBeNull();
      expect(container.querySelector('[data-testid="receive-network"]')).toBeNull();
      expect(mockQRCodeProps.mock.lastCall![0].caption).toBeUndefined();
    });

    // Every branch of handleShare, on a test network (the network-named text) and
    // on mainnet (the bare address). The native file branch base64-encodes the QR
    // through FileReader, which finishes after the click's act settles, hence waitFor.
    const SHARE_BRANCHES = [
      {
        branch: 'native + file',
        mobile: true,
        qr: true,
        writes: ['miden-address.png'],
        call: (text: string) => ({ text, files: [QR_FILE_URI], dialogTitle: 'receive' })
      },
      {
        branch: 'native text-only',
        mobile: true,
        qr: false,
        writes: [],
        call: (text: string) => ({ text, dialogTitle: 'receive' })
      },
      {
        branch: 'web + file',
        mobile: false,
        qr: true,
        writes: [],
        call: (text: string) => ({ files: [expect.any(File)], text })
      },
      {
        branch: 'web text-only',
        mobile: false,
        qr: false,
        writes: [],
        call: (text: string) => ({ text })
      }
    ];
    const SHARE_CASES = SHARE_BRANCHES.flatMap(branch => [
      { ...branch, network: 'devnet', networkKey: 'devnet' as const, text: 'shareAddressText:devnet:test-account-123' },
      { ...branch, network: 'mainnet', networkKey: null, text: 'test-account-123' }
    ]);

    it.each(SHARE_CASES)(
      'shares through the $branch branch on $network',
      async ({ mobile, qr, networkKey, text, writes, call }) => {
        mockNetworkKey = networkKey;
        mockIsMobile.mockReturnValue(mobile);
        mockQrBlob = qr ? new Blob(['qr'], { type: 'image/png' }) : null;
        const container = await renderReceive();

        await clickShare(container);

        const used = mobile ? jest.mocked(Share.share) : share;
        await waitFor(() => expect(used).toHaveBeenCalledTimes(1));
        expect(used).toHaveBeenCalledWith(call(text));
        expect(mobile ? share : Share.share).not.toHaveBeenCalled();
        expect(jest.mocked(Filesystem.writeFile).mock.calls.map(([options]) => options.path)).toEqual(writes);
        // A successful share returns before the copy fallback, and shares once.
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(used).toHaveBeenCalledTimes(1);
        expect(mockClipboardWrite).not.toHaveBeenCalled();
      }
    );

    // Web Share without file support still sends the network-named text, just no QR image.
    // One network is enough: shareText is computed once, and the matrix above covers both.
    const CAPABILITY_CASES = [
      {
        label: 'canShare returns false',
        setup: () => Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true })
      },
      {
        label: 'canShare is absent',
        setup: () => delete (navigator as { canShare?: unknown }).canShare
      }
    ];

    it.each(CAPABILITY_CASES)('shares text only on web when $label', async ({ setup }) => {
      mockNetworkKey = 'devnet';
      mockQrBlob = new Blob(['qr'], { type: 'image/png' });
      setup();
      const container = await renderReceive();

      await clickShare(container);

      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      expect(share).toHaveBeenCalledWith({ text: 'shareAddressText:devnet:test-account-123' });
      expect(mockClipboardWrite).not.toHaveBeenCalled();
    });

    it.each([
      { platform: 'web', mobile: false },
      { platform: 'native', mobile: true }
    ])('shares text only when rendering the QR image fails ($platform), and says so', async ({ mobile }) => {
      mockNetworkKey = 'devnet';
      mockIsMobile.mockReturnValue(mobile);
      mockQrError = new Error('canvas gone');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const container = await renderReceive();
        await clickShare(container);

        const used = mobile ? jest.mocked(Share.share) : share;
        await waitFor(() => expect(used).toHaveBeenCalledTimes(1));
        expect(used).toHaveBeenCalledWith(
          mobile
            ? { text: 'shareAddressText:devnet:test-account-123', dialogTitle: 'receive' }
            : { text: 'shareAddressText:devnet:test-account-123' }
        );
        expect(warn).toHaveBeenCalledWith('[Receive] failed to render QR image for share:', mockQrError);
        expect(Filesystem.writeFile).not.toHaveBeenCalled();
        expect(mockClipboardWrite).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    // When nothing can share, or the share fails, the address goes to the clipboard instead
    // (bare, by design: F-012).
    const FALLBACK_CASES = [
      {
        label: 'the web has no navigator.share',
        mobile: false,
        qr: false,
        setup: () => delete (navigator as { share?: unknown }).share,
        warns: false
      },
      {
        label: 'the web share rejects',
        mobile: false,
        qr: false,
        setup: () => share.mockRejectedValue(new Error('dismissed')),
        warns: true
      },
      {
        label: 'the native share rejects',
        mobile: true,
        qr: false,
        setup: () => jest.mocked(Share.share).mockRejectedValueOnce(new Error('dismissed')),
        warns: true
      },
      {
        label: 'writing the QR file rejects',
        mobile: true,
        qr: true,
        setup: () => jest.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error('no space')),
        warns: true
      }
    ];

    it.each(FALLBACK_CASES)('copies the address when $label', async ({ mobile, qr, setup, warns }) => {
      mockNetworkKey = 'devnet';
      mockIsMobile.mockReturnValue(mobile);
      mockQrBlob = qr ? new Blob(['qr'], { type: 'image/png' }) : null;
      setup();
      const dismissed = [['[Receive] share dismissed:', expect.any(Error)]];
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const container = await renderReceive();
        await clickShare(container);

        await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'test-account-123' }));
        expect(warn.mock.calls).toEqual(warns ? dismissed : []);
      } finally {
        warn.mockRestore();
      }
    });

    // The fallback used to write to the clipboard unawaited and uncaught, so a rejected write was an
    // unhandled promise rejection. It now goes through the hook the page's copy control uses, which
    // catches - silently, by design: the address stays on screen to copy by hand.
    it('handles a rejected clipboard write in the fallback', async () => {
      mockIsMobile.mockReturnValue(false);
      delete (navigator as { share?: unknown }).share;
      mockClipboardWrite.mockRejectedValueOnce(new Error('clipboard denied'));
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const container = await renderReceive();
        await clickShare(container);
        await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'test-account-123' }));
        // Give an unhandled rejection a macrotask to surface.
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
        });

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('copies the address when reading the QR image fails on native', async () => {
      mockNetworkKey = 'devnet';
      mockIsMobile.mockReturnValue(true);
      mockQrBlob = new Blob(['qr'], { type: 'image/png' });
      const read = jest.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
        this.onerror?.call(this, new ProgressEvent('error') as ProgressEvent<FileReader>);
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const container = await renderReceive();
        await clickShare(container);

        await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'test-account-123' }));
        expect(Filesystem.writeFile).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[Receive] share dismissed:', expect.any(Error));
      } finally {
        read.mockRestore();
        warn.mockRestore();
      }
    });

    it('names the source network of the cross-chain route', async () => {
      const container = await renderReceive();

      expect(container.querySelector('[data-testid="receive-cross-chain"]')?.textContent).toContain(
        'crossChainFromNetwork:ethereumSepolia:'
      );
    });
  });
});
