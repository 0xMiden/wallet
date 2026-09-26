import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';
import { hapticLight } from 'lib/mobile/haptics';
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

jest.mock('./GuardianInfoDrawer', () => ({
  GuardianInfoDrawer: ({ open }: { open: boolean }) => <div data-testid="info-drawer" data-open={String(open)} />
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

const CHECKS = ['local-state', 'seed-phrase', 'guardian'].map(id => `onboarding-meet-guardian-check-${id}`);

const tickAll = () => CHECKS.forEach(id => fireEvent.click(screen.getByTestId(id)));

type HarnessProps = Omit<React.ComponentProps<typeof MeetGuardianScreen>, 'progress' | 'onProgressChange'> & {
  initialProgress?: MeetGuardianProgress;
};

/** Owns the step's progress the way OnboardingFlow does. */
const Harness: React.FC<HarnessProps> = ({
  initialProgress = { checked: {}, chosenId: null, pickedByUser: false },
  ...props
}) => {
  const [progress, setProgress] = React.useState<MeetGuardianProgress>(initialProgress);
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
});

describe('MeetGuardianScreen', () => {
  it('opens on the title, the explainer and three unchecked facts as plain rows, with Continue closed', () => {
    renderScreen();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('setUpYourAccount');
    // The same left-aligned step heading as the testnet notice before it.
    expect(heading).toHaveClass('text-title-tab');
    expect(heading.parentElement).toHaveClass('items-start');
    expect(heading.closest('[data-slot="body"]')).toHaveClass('overflow-y-auto');
    expect(heading.closest('[data-slot="body"]')).not.toHaveClass('px-6');
    expect(screen.getByText('setUpYourAccountDescription')).toHaveClass('text-muted');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach(box => expect(box).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByRole('checkbox', { name: 'meetGuardianSeedPhraseTitle' })).toHaveAccessibleDescription(
      'meetGuardianSeedPhraseBody'
    );
    // Plain rows on the page, no group fill.
    expect(boxes[0]!.parentElement).not.toHaveClass('bg-fill');
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
    expect(screen.queryByTestId('meet-guardian-card')).toBeNull();
  });

  it('leads with the Guardian section above the facts, before anything is ticked', () => {
    const view = renderScreen();
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });

    // Shown from the start, not unfolded by the last tick.
    const section = screen.getByTestId('meet-guardian-section');
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(section).toHaveTextContent('meetGuardianYourGuardian');
    const firstFact = screen.getByTestId(CHECKS[0]!);
    expect(section.compareDocumentPosition(firstFact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Continue still waits for the three ticks.
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
    tickAll();
    expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
  });

  it('opens the "What is a Guardian?" sheet from the section header', () => {
    renderScreen();

    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'false');
    fireEvent.click(screen.getByTestId('meet-guardian-info'));
    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'true');
    // TextAction owns the tap haptic: one tap, one buzz.
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('shows the checking card while no operator has answered, and keeps Continue closed after every tick', () => {
    renderScreen();

    expect(screen.getByTestId('meet-guardian-checking')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianChecking')).toBeInTheDocument();
    tickAll();
    expect(screen.getByTestId('meet-guardian-checking')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
  });

  it("offers the chosen operator's change action as TextAction's row, with its one haptic and focus ring", () => {
    const onChooseDifferent = jest.fn();
    const view = renderScreen({ onChooseDifferent });
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });

    const action = within(screen.getByTestId('meet-guardian-card')).getByTestId('meet-guardian-choose-different');
    expect(action).toHaveClass('focus-visible:ring-accent-primary', 'w-full', 'justify-between');
    fireEvent.click(action);
    expect(onChooseDifferent).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('picks the fastest online operator once every operator has answered, and submits it', () => {
    const onSubmit = jest.fn();
    const view = renderScreen({ onSubmit });
    tickAll();

    // Only one verdict in: the choice waits for the whole round, so a slow operator is not
    // beaten by whoever answered first.
    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 120 } });
    expect(screen.queryByTestId('meet-guardian-card')).toBeNull();

    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    // No status and no number while it is up: the ranking is one moment's measurement.
    expect(screen.queryByTestId('meet-guardian-offline')).toBeNull();
    expect(screen.queryByText(/42/)).toBeNull();
    expect(screen.getByText('meetGuardianFastestOf:2')).toBeInTheDocument();
    expect(screen.getByText('guardianBioGateway')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianCannotMoveFunds')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianBacksUpState')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianCanSwitch')).toBeInTheDocument();
    // Every guarantee is drawn with the same check, none with a cross.
    const card = screen.getByTestId('meet-guardian-card');
    expect(card.querySelectorAll('li')).toHaveLength(3);
    expect(card.querySelectorAll('li .bg-positive-tint')).toHaveLength(3);
    expect(screen.getByTestId('meet-guardian-fastest')).toHaveTextContent('meetGuardianFastestOf:2');

    const button = screen.getByTestId('meet-guardian-continue');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'gateway', guardianEndpoint: GATEWAY.endpoint });
  });

  it('keeps the chosen operator when a later round changes the order, but closes Continue when it goes offline', () => {
    const view = renderScreen();
    tickAll();
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');

    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 10 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 90 }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(screen.queryByTestId('meet-guardian-offline')).toBeNull();

    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 10 },
      [GATEWAY.endpoint]: { status: 'offline' }
    });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(screen.getByTestId('meet-guardian-offline')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
  });

  it('says so when no operator is reachable, and still offers the picker through a later recovery', () => {
    const view = renderScreen();
    tickAll();
    view.setVerdicts({ [OZ.endpoint]: { status: 'offline' }, [GATEWAY.endpoint]: { status: 'offline' } });

    expect(screen.getByTestId('meet-guardian-none-reachable')).toHaveTextContent('meetGuardianNoneReachable');
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();

    // The next round finds one: the choice is made then.
    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 30 }, [GATEWAY.endpoint]: { status: 'offline' } });
    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
    expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
  });

  it('offers the picker while the first round is still out', () => {
    const onChooseDifferent = jest.fn();
    renderScreen({ onChooseDifferent });
    tickAll();

    expect(screen.getByTestId('meet-guardian-checking')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(onChooseDifferent).toHaveBeenCalledTimes(1);
  });

  it('offers the picker when no operator is reachable', () => {
    const onChooseDifferent = jest.fn();
    const view = renderScreen({ onChooseDifferent });
    tickAll();
    view.setVerdicts({ [OZ.endpoint]: { status: 'offline' }, [GATEWAY.endpoint]: { status: 'offline' } });

    expect(screen.getByTestId('meet-guardian-none-reachable')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(onChooseDifferent).toHaveBeenCalledTimes(1);
  });

  it('says no operator is reachable, without a picker, on a network with none', () => {
    mockGetGuardianOptions.mockReturnValue([]);
    renderScreen();
    tickAll();

    expect(screen.queryByTestId('meet-guardian-checking')).toBeNull();
    expect(screen.getByTestId('meet-guardian-none-reachable')).toHaveTextContent('meetGuardianNoneReachable');
    expect(screen.queryByTestId('meet-guardian-choose-different')).toBeNull();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
  });

  it('Choose a different Guardian hands off to the host', () => {
    const onChooseDifferent = jest.fn();
    const view = renderScreen({ onChooseDifferent });
    tickAll();
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 30 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 50 }
    });

    fireEvent.click(screen.getByTestId('meet-guardian-choose-different'));
    expect(onChooseDifferent).toHaveBeenCalledTimes(1);
  });

  it('offers the fully private account only when dev-gated on and all facts are ticked', () => {
    const onSubmit = jest.fn();
    const { rerender } = render(<Harness onSubmit={onSubmit} />);
    tickAll();
    expect(screen.queryByTestId('meet-guardian-no-guardian')).toBeNull();

    rerender(<Harness onSubmit={onSubmit} showNoGuardianOption />);
    fireEvent.click(screen.getByTestId('meet-guardian-no-guardian'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });

    // Untick one: the link goes with the card.
    fireEvent.click(screen.getByTestId(CHECKS[0]!));
    expect(screen.queryByTestId('meet-guardian-no-guardian')).toBeNull();
  });

  it.each([false, true])(
    'shows a card kept from before the picker at once, checking until its first verdict (picked by user: %s)',
    pickedByUser => {
      const view = renderScreen({
        initialProgress: {
          checked: { 'local-state': true, 'seed-phrase': true, guardian: true },
          chosenId: GATEWAY.id,
          pickedByUser
        }
      });

      const card = screen.getByTestId('meet-guardian-card');
      expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
      expect(screen.getByTestId('meet-guardian-checking-status')).toBeInTheDocument();
      expect(card).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByTestId('meet-guardian-offline')).toBeNull();
      expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();

      view.setVerdicts({ [GATEWAY.endpoint]: { status: 'online', latencyMs: 30 } });
      expect(screen.queryByTestId('meet-guardian-checking-status')).toBeNull();
      expect(screen.getByTestId('meet-guardian-card')).toHaveAttribute('aria-busy', 'false');
      expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
    }
  );

  it('drops the "fastest" caption for an operator the user picked in the full picker', () => {
    const view = renderScreen({
      initialProgress: {
        checked: { 'local-state': true, 'seed-phrase': true, guardian: true },
        chosenId: OZ.id,
        pickedByUser: true
      }
    });
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });

    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('OpenZeppelin');
    expect(screen.queryByText(/meetGuardianFastestOf/)).toBeNull();
    expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
  });

  it('replaces a choice that matches no operator with the fastest, as its own pick', () => {
    const view = renderScreen({
      initialProgress: {
        checked: { 'local-state': true, 'seed-phrase': true, guardian: true },
        chosenId: 'custom',
        pickedByUser: true
      }
    });
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });

    expect(screen.getByTestId('meet-guardian-name')).toHaveTextContent('Gateway Operator');
    expect(screen.getByText('meetGuardianFastestOf:2')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeEnabled();
  });

  it('names the only operator without a count when the network has one', () => {
    mockGetGuardianOptions.mockReturnValue([{ ...OZ }]);
    const view = renderScreen();
    tickAll();
    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 30 } });
    expect(screen.getByText('meetGuardianOnlyOperator')).toBeInTheDocument();
  });
});

describe('MeetGuardianScreen: shared pieces', () => {
  it('draws the header, the guarantees and the checklist from the shared components', () => {
    const view = renderScreen();
    view.setVerdicts({
      [OZ.endpoint]: { status: 'online', latencyMs: 120 },
      [GATEWAY.endpoint]: { status: 'online', latencyMs: 42 }
    });

    // The header is SectionHeader, flush, with the info action as its action.
    const header = screen.getByTestId('meet-guardian-header');
    expect(header).toHaveClass('px-0', 'pb-0');
    expect(within(header).getByRole('heading', { level: 2 })).toHaveTextContent('meetGuardianYourGuardian');
    expect(within(header).getByTestId('meet-guardian-info')).toBeInTheDocument();

    // The guarantees are FactRow items with a small tinted IconCircle, in an outlined list.
    const list = screen.getByTestId('meet-guardian-guarantees');
    expect(list.tagName).toBe('UL');
    expect(list).toHaveClass('rounded-2xl', 'border', 'border-hairline');
    const items = Array.from(list.children);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.tagName).toBe('LI');
      expect(item).toHaveAttribute('data-slot', 'fact-row');
      expect(item.querySelector('[data-slot="icon"]')).toHaveClass('size-5', 'bg-positive-tint');
    }

    // The checklist keeps each row's own inset through ListGroup, not a page override, and its full height.
    const group = screen.getAllByRole('checkbox')[0]!.parentElement!;
    expect(group).toHaveClass('shrink-0', '[&>*]:before:left-[var(--row-flush-inset,0px)]');
    expect(group.className).not.toContain('before:left-9');

    // A long operator name clips inside its column.
    expect(screen.getByTestId('meet-guardian-name')).toHaveClass('truncate', 'max-w-full');
  });

  it('offers the one change action, the row, while checking and when no operator answers', () => {
    const view = renderScreen();
    const row = () => screen.getByTestId('meet-guardian-choose-different');
    expect(screen.getByTestId('meet-guardian-checking')).toContainElement(row());
    expect(row()).toHaveClass('w-full', 'justify-between');

    view.setVerdicts({
      [OZ.endpoint]: { status: 'offline' },
      [GATEWAY.endpoint]: { status: 'offline' }
    });
    expect(screen.getByTestId('meet-guardian-none-reachable')).toBeInTheDocument();
    expect(row()).toHaveClass('w-full', 'justify-between');
  });
});
