import React from 'react';

import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { fireEvent, waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { PageActiveContext } from 'app/layouts/page-active';
import { reducedMotionTransition, tabBarMotion } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

import { Receive } from './Receive';

// Surface the motion props the QR frame hands framer, so the logo's press dip is assertable, and
// keep every other `motion.*` real (the copy button animates its own glyph).
let mockReduceMotion = false;
jest.mock('framer-motion', () => {
  const actual = jest.requireActual('framer-motion');
  const ReactActual = jest.requireActual('react');
  const MotionDiv = ReactActual.forwardRef(({ animate, transition, children, ...rest }: any, ref: any) => (
    <div
      ref={ref}
      data-animate={JSON.stringify(animate ?? null)}
      data-transition={JSON.stringify(transition ?? null)}
      {...rest}
    >
      {children}
    </div>
  ));
  return {
    ...actual,
    useReducedMotion: () => mockReduceMotion,
    motion: new Proxy(actual.motion, { get: (target: any, key: string) => (key === 'div' ? MotionDiv : target[key]) })
  };
});

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
const mockCopy = jest.fn();
jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: mockCopy, copied: false })
}));

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
    mockReduceMotion = false;
    mockNetworkKey = 'testnet';
    mockQRCodeProps.mockClear();
    mockQrBlob = null;
    mockQrError = null;
    mockCopy.mockClear();
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

  const renderReceive = async (pageActive = true) => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(
        <PageActiveContext.Provider value={pageActive}>
          <Receive />
        </PageActiveContext.Provider>
      );
    });
    return testContainer;
  };

  /** Re-renders under a different page-active value, as leaving the tab does. */
  const setPageActive = async (pageActive: boolean) => {
    await act(async () => {
      testRoot!.render(
        <PageActiveContext.Provider value={pageActive}>
          <Receive />
        </PageActiveContext.Provider>
      );
    });
  };

  it('renders the account address', async () => {
    const container = await renderReceive();

    const full = container.querySelector('[data-testid="receive-address-full"]');
    expect(full?.textContent).toBe('test-account-123');
  });

  it('rolls the address to "copied" and morphs the glyph to a check for a beat, then reverts', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const container = await renderReceive();
    const copyButton = container.querySelector('[data-testid="receive-copy-address"]')!;

    // The address is a full-width 44px pill on `fill`, aligned with the notice and actions.
    expect(copyButton).toHaveClass('h-11', 'w-full', 'rounded-full', 'bg-fill', 'text-ink');
    // The shared CopyButton: the animated glyph leads, the address label rolls to "copied".
    const label = () => copyButton.querySelector('[data-copy-label] [data-present="true"]');
    const glyph = () => copyButton.querySelector('[data-copy-icon] [data-present="true"]');
    expect(copyButton.querySelector('[aria-live]')!.firstElementChild).toHaveAttribute('data-copy-icon');
    expect(label()?.textContent).toBe('test-acc');
    expect(glyph()).toHaveAttribute('data-copy-state', 'idle');

    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'test-account-123' });
    expect(label()?.textContent).toBe('copied');
    expect(glyph()).toHaveAttribute('data-copy-state', 'copied');

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(label()?.textContent).toBe('test-acc');
    expect(glyph()).toHaveAttribute('data-copy-state', 'idle');

    jest.useRealTimers();
  });

  it('warns about test funds in a quiet caption under the share and bridge actions (#875)', async () => {
    const container = await renderReceive();

    const warning = container.querySelector('[data-testid="receive-test-funds-warning"]')!;
    // The shared Notice in its inline variant: the warning tone and its glyph, but no tinted block
    // — between the address and the actions it was the loudest thing on the page.
    expect(warning).toHaveAttribute('role', 'note');
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(warning).toHaveAttribute('data-variant', 'inline');
    expect(warning.className).not.toMatch(/(^|\s)bg-|rounded-2xl|border-dashed/);
    expect(warning.querySelector('[data-slot="body"]')?.textContent).toBe('receiveTestFundsBody:testnet:');
    expect(warning.querySelector('[data-slot="body"]')).toHaveClass('text-caption', 'text-muted');
    expect(warning.querySelector('[data-slot="icon"]')).toHaveClass('text-pending-ink');
    // Last on the page: code, address, actions, then the warning that qualifies them.
    const shareButton = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'share')!;
    const crossChain = container.querySelector('[data-testid="receive-cross-chain"]')!;
    expect(warning.compareDocumentPosition(shareButton)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(warning.compareDocumentPosition(crossChain)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(container.querySelector('[data-testid="receive-actions"]')!.nextElementSibling).toBe(warning);
  });

  it('renders Share and Cross-chain as rows of one ListGroup, with one haptic per tap', async () => {
    const container = await renderReceive();

    const actions = container.querySelector('[data-testid="receive-actions"]')!;
    // The app's grouped fill list, like every other list in the wallet.
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

  it('leads with the page title, where send puts "Send to" and swap "You Pay"', async () => {
    const container = await renderReceive();

    const title = container.querySelector('[data-testid="receive-title"]')!;
    expect(title.tagName).toBe('H1');
    expect(title.textContent).toBe('receiveAt');
    // The same type style as the two tabs beside it, so the line does not move as you swipe.
    expect(title).toHaveClass('text-title-tab', 'text-ink');
    // First in the column, above the code.
    const block = container.querySelector('[data-testid="receive-qr-block"]')!;
    expect(block.parentElement!.contains(title)).toBe(true);
    expect(title.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the network in a NetworkChip and keeps the caption to the shared QR image', async () => {
    const container = await renderReceive();

    expect(container.querySelector('[data-testid="receive-network"]')?.textContent).toBe('qrNetworkCaption:testnet:');
    expect(mockQRCodeProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ caption: 'qrNetworkCaption:testnet:', showCaption: false, fluid: true, size: 300 })
    );
  });

  it('draws the code at a fixed, scannable size on the page itself, with no card around it', async () => {
    const container = await renderReceive();

    const card = container.querySelector('[data-testid="receive-qr-card"]')!;
    // No card: the code, its chip and the address sit straight on the page.
    expect(card.className).not.toContain('bg-page');
    expect(card.className).not.toContain('rounded-2xl');
    const slot = container.querySelector('[data-testid="receive-qr-slot"]')!;
    // 208px, not the leftover height: the rest of the page gets the room back.
    expect(slot).toHaveClass('relative', 'w-full', 'max-w-52');
    expect(slot).not.toHaveClass('flex-1');
    const frame = container.querySelector('[data-testid="receive-qr-frame"]')!;
    expect(frame).toHaveClass('aspect-square', 'w-full');
    expect(frame.className).not.toContain('max-h-72');
    // The chip and the address stay in the same block as the code.
    expect(card.contains(container.querySelector('[data-testid="receive-network"]'))).toBe(true);
    expect(card.contains(container.querySelector('[data-testid="receive-copy-address"]'))).toBe(true);
    // One column, the shared home-group pane body: the code block sits straight in it, at the
    // 16px gutter every pane shares.
    const column = container.querySelector('[data-testid="receive-qr-block"]')!.parentElement!;
    expect(column).toBe(container.querySelector('[data-testid="receive-page"]'));
    expect(column).toHaveClass('flex', 'flex-col', 'px-4', 'pt-6');
  });

  it('clears the docked tab bar from the same expression the flow CTAs use', async () => {
    // Was a fixed pb-18/pb-20 of its own. The shell takes it from `stepFooterCushionClass`, so a
    // pane with no CTA ends where a pane with one ends its button, and it collapses with the
    // keyboard rather than a frame later.
    mockIsMobile.mockReturnValue(true);
    const container = await renderReceive();

    expect(container.querySelector('[data-testid="receive-page"]')).toHaveClass(
      'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]'
    );
  });

  it('leaves the horizontal swipe to the home carousel', async () => {
    // A pane that can pan sideways takes the carousel's drag before HomeSwipeContainer sees it.
    const container = await renderReceive();

    const page = container.querySelector<HTMLElement>('[data-testid="receive-page"]')!;
    expect(page.style.touchAction).toBe('pan-y');
    expect(page).toHaveClass('overflow-x-hidden');
  });

  describe('the receive green', () => {
    it('paints the rows, the chevron and the copy glyph in the flow accent', async () => {
      const container = await renderReceive();

      // The page keeps the app's surface: the green is in the affordances, not a wash.
      expect(container.querySelector('[data-testid="receive-page"]')!.className).not.toContain(
        'bg-accent-receive-tint'
      );

      for (const testId of ['receive-share', 'receive-cross-chain']) {
        const row = container.querySelector(`[data-testid="${testId}"]`)!;
        expect(row.querySelector('[data-slot="icon"]')).toHaveClass('bg-accent-receive-tint', 'text-accent-receive');
        expect(row).toHaveClass('before:bg-accent-receive/25');
        // The titles stay `ink`: the accent is under 4.5:1 as text.
        expect(row.querySelector('[data-slot="title"]')).toHaveClass('text-ink');
      }
      expect(container.querySelector('[data-testid="receive-cross-chain"] [data-slot="chevron"]')).toHaveClass(
        'stroke-accent-receive'
      );

      const copy = container.querySelector('[data-testid="receive-copy-address"]')!;
      expect(copy.querySelector('[data-copy-icon]')).toHaveClass('text-accent-receive');
      expect(copy).toHaveClass('focus-visible:ring-accent-receive');
    });

    it('leaves the test-funds notice in its own warning tone', async () => {
      const container = await renderReceive();

      // A status is not an accent: the warning keeps saying "warning", green page or not.
      expect(container.querySelector('[data-testid="receive-test-funds-warning"]')).toHaveAttribute(
        'data-tone',
        'warning'
      );
    });

    it('names the network with the shared NetworkChip, in the same tint as send and contacts', async () => {
      const container = await renderReceive();

      const chip = container.querySelector('[data-testid="receive-network"]')!;
      expect(chip).toHaveClass('bg-network-miden-tint', 'text-network-miden-text');
      expect(chip.querySelector('[data-testid="miden-logo"]')).not.toBeNull();
    });
  });

  describe('the QR logo easter egg', () => {
    const logo = (container: HTMLElement) => container.querySelector('[data-testid="receive-qr-logo"]')! as HTMLElement;
    const palette = () => mockQRCodeProps.mock.lastCall![0].palette;

    it('opens on the flow green and walks the card palette, one tap at a time', async () => {
      const container = await renderReceive();

      expect(palette()).toBe('green');
      const order = ['orange', 'slate', 'blue', 'purple', 'green'];
      for (const next of order) {
        await act(async () => {
          fireEvent.click(logo(container));
        });
        expect(palette()).toBe(next);
      }
      // One haptic per tap, and the address never moved.
      expect(hapticLight).toHaveBeenCalledTimes(order.length);
      expect(container.querySelector('[data-testid="receive-address-full"]')?.textContent).toBe('test-account-123');
    });

    it('carries an accessible name and a 44px-clear target over the middle of the code', async () => {
      const container = await renderReceive();

      const button = logo(container);
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('aria-label', 'receiveQrColorAction');
      // 28% of the 208px code is 58px, past the 44px minimum.
      expect(button).toHaveClass('h-[28%]', 'w-[28%]', 'absolute', 'left-1/2', 'top-1/2');
    });

    it('dips the code while the logo is held, on the tab bar press spring', async () => {
      const container = await renderReceive();
      const frame = container.querySelector('[data-testid="receive-qr-frame"]')!;

      expect(JSON.parse(frame.getAttribute('data-animate')!)).toEqual({ scale: 1 });
      expect(JSON.parse(frame.getAttribute('data-transition')!)).toEqual(tabBarMotion.press);

      await act(async () => {
        fireEvent.pointerDown(logo(container));
      });
      expect(JSON.parse(frame.getAttribute('data-animate')!)).toEqual({ scale: tabBarMotion.pressScale });

      await act(async () => {
        fireEvent.pointerUp(logo(container));
      });
      expect(JSON.parse(frame.getAttribute('data-animate')!)).toEqual({ scale: 1 });
    });

    it('does not dip under reduced motion, and still cycles', async () => {
      mockReduceMotion = true;
      const container = await renderReceive();
      const frame = container.querySelector('[data-testid="receive-qr-frame"]')!;

      await act(async () => {
        fireEvent.pointerDown(logo(container));
      });
      expect(JSON.parse(frame.getAttribute('data-animate')!)).toEqual({ scale: 1 });
      expect(JSON.parse(frame.getAttribute('data-transition')!)).toEqual(reducedMotionTransition);

      await act(async () => {
        fireEvent.click(logo(container));
      });
      expect(palette()).toBe('orange');
    });

    it('goes back to the flow green once the page is no longer the one on screen', async () => {
      const container = await renderReceive();

      await act(async () => {
        fireEvent.click(logo(container));
      });
      expect(palette()).toBe('orange');

      // The tab stays mounted under another one, so leaving is a page-active change.
      await setPageActive(false);
      expect(palette()).toBe('green');
      await setPageActive(true);
      expect(palette()).toBe('green');
    });
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
        expect(mockCopy).not.toHaveBeenCalled();
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
      expect(mockCopy).not.toHaveBeenCalled();
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
        expect(mockCopy).not.toHaveBeenCalled();
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

        await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
        expect(warn.mock.calls).toEqual(warns ? dismissed : []);
      } finally {
        warn.mockRestore();
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

        await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
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
