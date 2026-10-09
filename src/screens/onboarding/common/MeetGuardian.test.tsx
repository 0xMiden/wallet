import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';
import { MeetGuardianProgress, NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { MeetGuardianScreen } from './MeetGuardian';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(',')}` : key)
  })
}));

// Provider list — controlled per test.
const mockGetGuardianOptions = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getGuardianOptionsForNetwork: (...args: unknown[]) => mockGetGuardianOptions(...args)
}));

// Probe verdicts — controlled per test so no real pings go out.
let mockVerdicts: Record<string, GuardianProbeVerdict> = {};
jest.mock('app/hooks/useGuardianAvailability', () => ({
  useGuardianPings: () => mockVerdicts
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));

// Vaul renders through a portal jsdom cannot drive; a flat stand-in renders a sheet only while it is open.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

// The sheet has its own test; here it only reports whether it is open and hands picks back.
type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  fastestId: string | null;
  onPick: (id: string) => void;
};
let mockSheet: SheetProps | null = null;
jest.mock('./GuardianProviderSheet', () => ({
  ...jest.requireActual('./GuardianProviderSheet'),
  GuardianProviderSheet: (props: SheetProps) => {
    mockSheet = props;
    return <div data-testid="provider-sheet" data-open={String(props.open)} />;
  }
}));

const OZ = {
  id: 'open-zeppelin',
  name: 'OpenZeppelin',
  operatedBy: 'OpenZeppelin',
  location: 'US-EAST',
  endpoint: 'https://oz.example.com'
};
const GATEWAY = {
  id: 'gateway',
  name: 'Gateway Operator',
  operatedBy: 'Gateway',
  location: 'EU-NORTH',
  endpoint: 'https://gw.example.com'
};
const UNLISTED = {
  id: 'unlisted',
  name: 'Unlisted',
  operatedBy: 'Unlisted Ltd',
  location: 'EU-SOUTH',
  endpoint: 'https://unlisted.example.com'
};

const BOTH_ONLINE = {
  [OZ.endpoint]: { status: 'online', latencyMs: 120 },
  [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
} as const;

type HarnessProps = Omit<React.ComponentProps<typeof MeetGuardianScreen>, 'progress' | 'onProgressChange'> & {
  initialProgress?: MeetGuardianProgress;
  onProgress?: (progress: MeetGuardianProgress) => void;
};

/** Owns the step's progress the way OnboardingFlow does. */
const Harness: React.FC<HarnessProps> = ({
  initialProgress = { chosenId: null, fastestId: null },
  onProgress,
  ...props
}) => {
  const [progress, setProgress] = React.useState<MeetGuardianProgress>(initialProgress);
  React.useEffect(() => onProgress?.(progress), [progress, onProgress]);
  return <MeetGuardianScreen {...props} progress={progress} onProgressChange={setProgress} />;
};

/** Re-render with new verdicts, as the hook would on a later ping round. */
const renderScreen = (props: HarnessProps = {}) => {
  const view = render(<Harness {...props} />);
  return {
    ...view,
    setVerdicts(next: Record<string, GuardianProbeVerdict>) {
      mockVerdicts = next;
      act(() => view.rerender(<Harness {...props} />));
    }
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGuardianOptions.mockReturnValue([{ ...OZ }, { ...GATEWAY }]);
  mockVerdicts = {};
  mockSheet = null;
});

describe('MeetGuardianScreen', () => {
  it('opens on its title with no checklist, and holds the operator shape with Continue closed while checking', () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('chooseYourGuardian');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('meet-guardian-checking')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('meetGuardianChecking')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
    expect(screen.getByTestId('meet-guardian-continue')).toHaveTextContent('continue');
  });

  it('picks the fastest online operator once every operator has answered, and Continue names and submits it', () => {
    const onSubmit = jest.fn();
    const view = renderScreen({ onSubmit });

    // Only one verdict in: the choice waits for the whole round, so a slow operator is not
    // beaten by whoever answered first.
    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 120 } });
    expect(screen.queryByTestId('meet-guardian-card')).toBeNull();

    view.setVerdicts(BOTH_ONLINE);
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(screen.getByTestId('meet-guardian-online')).toBeInTheDocument();
    // Who runs it, in its own sentence, and where.
    expect(screen.getByTestId('meet-guardian-summary')).toHaveTextContent('guardianAboutGateway');
    expect(screen.getByTestId('meet-guardian-region')).toHaveTextContent('meetGuardianRegion');
    expect(screen.getByTestId('meet-guardian-region')).toHaveTextContent('EU-NORTH');
    // No number: the ranking is one moment's measurement.
    expect(screen.queryByText(/42/)).toBeNull();

    const button = screen.getByTestId('meet-guardian-continue');
    expect(button).toHaveTextContent('meetGuardianContinueWith:Gateway Operator');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'gateway', guardianEndpoint: GATEWAY.endpoint });
  });

  it("falls back to the operator's company for an operator with no description", () => {
    mockGetGuardianOptions.mockReturnValue([{ ...UNLISTED }]);
    const view = renderScreen();
    view.setVerdicts({ [UNLISTED.endpoint]: { status: 'online', latencyMs: 10 } });
    expect(screen.getByTestId('meet-guardian-summary')).toHaveTextContent('Unlisted Ltd');
  });

  it('keeps the chosen operator when a later round changes the order, but closes Continue when it goes offline', () => {
    const view = renderScreen();
    view.setVerdicts(BOTH_ONLINE);
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');

    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 10 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 90 }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');

    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 10 }, [GATEWAY.endpoint]: { status: 'offline' } });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(screen.getByTestId('meet-guardian-offline')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
  });

  it('says so when no operator is reachable, still offers Change provider, and recovers on a later round', () => {
    const view = renderScreen();
    view.setVerdicts({ [OZ.endpoint]: { status: 'offline' }, [GATEWAY.endpoint]: { status: 'offline' } });

    expect(screen.getByTestId('meet-guardian-none-reachable')).toHaveTextContent('meetGuardianNoneReachable');
    expect(screen.getByTestId('meet-guardian-choose-different')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();

    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 30 }, [GATEWAY.endpoint]: { status: 'offline' } });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
    expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
  });

  it('says no operator is reachable, without Change provider, on a network with none', () => {
    mockGetGuardianOptions.mockReturnValue([]);
    renderScreen();
    expect(screen.getByTestId('meet-guardian-none-reachable')).toBeInTheDocument();
    expect(screen.queryByTestId('meet-guardian-choose-different')).toBeNull();
  });

  it('opens the provider sheet from Change provider, on the chosen operator, tagging the fastest', () => {
    const view = renderScreen();
    expect(screen.getByTestId('provider-sheet')).toHaveAttribute('data-open', 'false');
    view.setVerdicts(BOTH_ONLINE);

    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(screen.getByTestId('meet-guardian-choose-different')).toHaveTextContent('meetGuardianChangeProvider');
    expect(screen.getByTestId('provider-sheet')).toHaveAttribute('data-open', 'true');
    expect(mockSheet?.value).toBe('gateway');
    expect(mockSheet?.fastestId).toBe('gateway');
  });

  it("takes a pick from the sheet as the user's own, and a later round never swaps it", () => {
    const onProgress = jest.fn();
    const onSubmit = jest.fn();
    const view = renderScreen({ onProgress, onSubmit });
    view.setVerdicts(BOTH_ONLINE);

    act(() => mockSheet?.onPick('open-zeppelin'));
    expect(onProgress).toHaveBeenLastCalledWith({ chosenId: 'open-zeppelin', fastestId: 'gateway' });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');

    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 500 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
    fireEvent.click(screen.getByTestId('meet-guardian-continue'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'open-zeppelin', guardianEndpoint: OZ.endpoint });
  });

  // The tag says why the step chose what it chose, so it is that round's measurement, not the latest one.
  it('keeps the Fastest tag on the operator locked in when a later round ranks another first', () => {
    const view = renderScreen();
    view.setVerdicts(BOTH_ONLINE);
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 10 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 90 }
    });

    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(mockSheet?.fastestId).toBe('gateway');
  });

  it("records the first round's fastest even when the user picked another while it was out", () => {
    const view = renderScreen();
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    act(() => mockSheet?.onPick('open-zeppelin'));
    view.setVerdicts(BOTH_ONLINE);
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 10 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 90 }
    });

    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(mockSheet?.value).toBe('open-zeppelin');
    expect(mockSheet?.fastestId).toBe('gateway');
  });

  it('keeps the Fastest tag recorded before the user left the step and came back', () => {
    const view = renderScreen({ initialProgress: { chosenId: 'open-zeppelin', fastestId: 'open-zeppelin' } });
    view.setVerdicts(BOTH_ONLINE);
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(mockSheet?.fastestId).toBe('open-zeppelin');
  });

  it("keeps the pick and Continue's label when the sheet is closed without a pick and opened again", () => {
    const view = renderScreen();
    view.setVerdicts(BOTH_ONLINE);
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    act(() => mockSheet?.onPick('open-zeppelin'));

    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    act(() => mockSheet?.onOpenChange(false));
    expect(screen.getByTestId('provider-sheet')).toHaveAttribute('data-open', 'false');
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));

    expect(screen.getByTestId('provider-sheet')).toHaveAttribute('data-open', 'true');
    expect(mockSheet?.value).toBe('open-zeppelin');
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
    expect(screen.getByTestId('meet-guardian-continue')).toHaveTextContent('meetGuardianContinueWith:OpenZeppelin');
  });

  it('keeps an operator the user picked earlier, however it ranks', () => {
    const view = renderScreen({ initialProgress: { chosenId: 'open-zeppelin', fastestId: null } });
    view.setVerdicts(BOTH_ONLINE);
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
  });

  it('replaces a choice that matches no operator with the fastest, as its own pick', () => {
    const onProgress = jest.fn();
    const view = renderScreen({ initialProgress: { chosenId: 'gone', fastestId: null }, onProgress });
    view.setVerdicts(BOTH_ONLINE);
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(onProgress).toHaveBeenLastCalledWith({ chosenId: 'gateway', fastestId: 'gateway' });
  });

  it("opens the shown operator's details from Learn more, keeping them out of the page until asked for", () => {
    const view = renderScreen();
    view.setVerdicts(BOTH_ONLINE);
    expect(screen.queryByTestId('meet-guardian-provider-details')).toBeNull();
    expect(screen.queryByText('gw.example.com')).toBeNull();

    const learnMore = screen.getByTestId('meet-guardian-learn-more');
    expect(learnMore).toHaveTextContent('meetGuardianLearnMore');
    fireEvent.click(learnMore);

    const details = screen.getByTestId('meet-guardian-provider-details');
    expect(within(details).getByRole('heading', { level: 2 })).toHaveTextContent('Gateway Operator');
    expect(details).toHaveTextContent('guardianAboutGateway');
    expect(details).toHaveTextContent('guardianProvider');
    expect(details).toHaveTextContent('Gateway');
    expect(details).toHaveTextContent('guardianRegion');
    expect(details).toHaveTextContent('EU-NORTH');
    expect(details).toHaveTextContent('guardianEndpointLabel');
    expect(details).toHaveTextContent('gw.example.com');
  });

  it('offers no Learn more until an operator is shown', () => {
    renderScreen();
    expect(screen.queryByTestId('meet-guardian-learn-more')).toBeNull();
  });

  it('offers the fully private account when dev-gated on, and submits no guardian from it', () => {
    const onSubmit = jest.fn();
    renderScreen({ onSubmit, showNoGuardianOption: true });
    fireEvent.click(screen.getByTestId('meet-guardian-no-guardian'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });
  });

  it('does not offer the fully private account when dev-gated off', () => {
    renderScreen({ showNoGuardianOption: false });
    expect(screen.queryByTestId('meet-guardian-no-guardian')).toBeNull();
  });
});
