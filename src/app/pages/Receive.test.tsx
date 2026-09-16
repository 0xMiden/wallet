import React from 'react';

import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { waitFor } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ROUTE_DWELL_MS } from 'lib/telemetry/use-route-dwell';

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

jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: false, sidePanel: false })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Add: 'Add', CrossChain: 'CrossChain', Share: 'Share', WarningFill: 'WarningFill' }
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

let mockPublicKey = 'test-account-123';

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: mockPublicKey })
}));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: () => 'unknown'
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

let mockPathname = '/receive';

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  // The receive flow only reports while its route is showing: the home carousel
  // keeps this page mounted for the whole session, so a mount-triggered flow
  // fired on every app open.
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr?.slice(0, 8) || ''
}));

// Both suites render this page as if its route were showing; the one test that
// checks the carousel case sets this to another page for itself.
beforeEach(() => {
  mockPathname = '/receive';
});

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
    mockCopy.mockClear();
    mockIsMobile.mockReturnValue(false);
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

  it('warns about test funds before the share and bridge actions (#875)', async () => {
    const container = await renderReceive();

    const warning = container.querySelector('[data-testid="receive-test-funds-warning"]')!;
    expect(warning.textContent).toContain('receiveTestFundsTitle');
    expect(warning.textContent).toContain('receiveTestFundsBody');
    const shareButton = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'share')!;
    const crossChain = container.querySelector('[data-testid="receive-cross-chain"]')!;
    expect(warning.compareDocumentPosition(shareButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(warning.compareDocumentPosition(crossChain)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

// The receive surface is a view: its job is to put a usable address in front of
// the user (QR, copy, share), so that is what "completed" means here.
describe('Receive - receive_share telemetry', () => {
  /** Throwing accessor so a missing handle names how many flows were begun. */
  const handleAt = (index: number): TelemetryHandle => {
    const handle = telemetryHandles[index];
    if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
    return handle;
  };

  /** Everything this suite handed to telemetry, for the privacy assertions. */
  const telemetryPayload = () =>
    JSON.stringify({
      begun: beginFlowMock.mock.calls,
      settled: telemetryHandles.map(handle => [
        handle.complete.mock.calls,
        handle.cancel.mock.calls,
        handle.fail.mock.calls
      ])
    });

  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  /**
   * Let the route settle. Entering a pane no longer begins its flow on arrival:
   * the carousel commits a route on every swipe release, so a route has to hold
   * still to count as a visit — see `useRouteDwell`. Every render helper below
   * dwells by default, since that is what a real visit does; the tests that
   * exercise a transit are the ones that deliberately do not.
   */
  const dwell = async () => {
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_DWELL_MS);
    });
  };

  const mount = async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(<Receive />);
    });
  };

  const renderReceive = async () => {
    await mount();
    await dwell();
  };

  /** Re-render in place, as a route change does — no unmount. */
  const rerenderReceive = async () => {
    await act(async () => {
      testRoot!.render(<Receive />);
    });
    await dwell();
  };

  const unmountReceive = async () => {
    await act(async () => {
      testRoot!.unmount();
    });
    testRoot = null;
  };

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    mockPublicKey = 'test-account-123';
  });

  afterEach(async () => {
    if (testRoot) await unmountReceive();
    jest.useRealTimers();
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('reports nothing while another home page is showing, since the carousel keeps this one mounted', async () => {
    // TabLayout renders Overview / Send / Receive / Earn / Swap as one carousel
    // and mounts every page at once for the whole session. The address renders
    // unconditionally, so a mount-triggered flow both began AND completed a
    // receive-address share on every single app open — making this the wallet's
    // most numerous event and none of it evidence that anyone shared anything.
    mockPathname = '/';

    await renderReceive();

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('completes the share when the user arrives from another home page, not just on a direct mount', async () => {
    // The production sequence, and the one the route gate broke: this page is
    // mounted by the carousel while the app is at `/`, so the flow starts on the
    // LATER navigation to `/receive`. An effect keyed only on the address would
    // have run once at mount, found no flow, and never fired again — reporting
    // every share as abandoned.
    mockPathname = '/';
    await renderReceive();
    expect(beginFlowMock).not.toHaveBeenCalled();

    mockPathname = '/receive';
    await rerenderReceive();

    expect(beginFlowMock).toHaveBeenCalledWith('receive_share');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('begins one receive_share flow on entry', async () => {
    await renderReceive();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('receive_share');
  });

  it('completes the flow once the address is presented', async () => {
    await renderReceive();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('does not re-report the presented address on unmount', async () => {
    await renderReceive();

    await unmountReceive();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('cancels the flow when there is no address to present', async () => {
    mockPublicKey = '';

    await renderReceive();
    expect(handleAt(0).complete).not.toHaveBeenCalled();

    await unmountReceive();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('completes a flow that was waiting once the address arrives', async () => {
    mockPublicKey = '';
    await renderReceive();

    mockPublicKey = 'test-account-123';
    await rerenderReceive();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a pane the carousel only swiped past', async () => {
    // Receive sits between Send and Earn, so it is the pane transited most, and
    // its flow completes on sight of the address — meaning a swipe past it used
    // to emit a `completed` share indistinguishable from a real one. No
    // duration filter on the reading side could separate them, because both
    // last milliseconds. This is why the gate is a dwell and not a route check.
    mockPathname = '/';
    await mount();

    mockPathname = '/receive';
    await act(async () => {
      testRoot!.render(<Receive />);
    });
    // Swiped straight on to Earn without stopping.
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_DWELL_MS - 1);
    });
    mockPathname = '/earn';
    await act(async () => {
      testRoot!.render(<Receive />);
    });
    await dwell();

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('never passes the address to telemetry', async () => {
    await renderReceive();

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('test-account-123');
  });
});
