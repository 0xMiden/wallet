import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';
import { NO_GUARDIAN_ID } from 'screens/onboarding/types';

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
  useGuardianProbe: () => mockVerdicts
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

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

/** Re-render with new verdicts, as the hook would on a later ping round. */
const renderScreen = (props: React.ComponentProps<typeof MeetGuardianScreen> = {}) => {
  const view = render(<MeetGuardianScreen {...props} />);
  return {
    ...view,
    setVerdicts(next: Record<string, GuardianProbeVerdict>) {
      mockVerdicts = next;
      act(() => view.rerender(<MeetGuardianScreen {...props} />));
    }
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGuardianOptions.mockReturnValue([{ ...OZ }, { ...GATEWAY }]);
  mockVerdicts = {};
});

describe('MeetGuardianScreen', () => {
  it('opens on the title, the explainer and three unchecked facts in one group, with Continue closed', () => {
    renderScreen();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('setUpYourAccount');
    expect(heading).toHaveClass('text-hero-value');
    expect(heading.parentElement).toHaveClass('items-center', 'text-center');
    expect(heading.closest('[data-slot="body"]')).toHaveClass('px-6', 'overflow-y-auto');
    expect(screen.getByText('setUpYourAccountDescription')).toHaveClass('text-muted');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach(box => expect(box).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByRole('checkbox', { name: 'meetGuardianSeedPhraseTitle' })).toHaveAccessibleDescription(
      'meetGuardianSeedPhraseBody'
    );
    expect(boxes[0]!.parentElement).toHaveClass('rounded-2xl', 'bg-fill');
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
    expect(screen.queryByTestId('meet-guardian-card')).toBeNull();
  });

  it('shows the checking card once all facts are ticked and no operator has answered yet', () => {
    renderScreen();
    tickAll();

    expect(screen.getByTestId('meet-guardian-checking')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianChecking')).toBeInTheDocument();
    expect(screen.getByTestId('meet-guardian-continue')).toBeDisabled();
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
    // A status word, never the number: the ranking is one moment's measurement.
    expect(screen.getByTestId('meet-guardian-online')).toBeInTheDocument();
    expect(screen.queryByText(/42/)).toBeNull();
    expect(screen.getByText('meetGuardianFastestOf:2')).toBeInTheDocument();
    expect(screen.getByText('guardianBioGateway:2')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianCannotMoveFunds')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianBacksUpState')).toBeInTheDocument();
    expect(screen.getByText('meetGuardianCanSwitch')).toBeInTheDocument();
    // Every guarantee is drawn with the same check, none with a cross.
    const card = screen.getByTestId('meet-guardian-card');
    expect(card.querySelectorAll('li')).toHaveLength(3);
    expect(card.querySelectorAll('li .text-positive-ink')).toHaveLength(3);

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
    expect(screen.getByTestId('meet-guardian-online')).toBeInTheDocument();

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
    const { rerender } = render(<MeetGuardianScreen onSubmit={onSubmit} />);
    tickAll();
    expect(screen.queryByTestId('meet-guardian-no-guardian')).toBeNull();

    rerender(<MeetGuardianScreen onSubmit={onSubmit} showNoGuardianOption />);
    fireEvent.click(screen.getByTestId('meet-guardian-no-guardian'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });

    // Untick one: the link goes with the card.
    fireEvent.click(screen.getByTestId(CHECKS[0]!));
    expect(screen.queryByTestId('meet-guardian-no-guardian')).toBeNull();
  });

  it('names the only operator without a count when the network has one', () => {
    mockGetGuardianOptions.mockReturnValue([{ ...OZ }]);
    const view = renderScreen();
    tickAll();
    view.setVerdicts({ [OZ.endpoint]: { status: 'online', latencyMs: 30 } });
    expect(screen.getByText('meetGuardianOnlyOperator')).toBeInTheDocument();
  });
});
