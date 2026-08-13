import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ITransaction } from 'lib/miden/db/types';

import { GuardianRotationSuccess } from './GuardianRotationSuccess';
import type { TransactionSuccessLayoutProps } from './TransactionSuccessLayout';

/**
 * `GuardianRotationSuccess` is the dedicated "Guardian Updated!" receipt shown
 * after a `switch-guardian` rotation commits. It reads the previous/new
 * provider ONLY from the persisted `extraInputs` audit trail (never the live
 * account endpoint, which already reads as the NEW provider post-switch) and
 * hands the real `GuardianTransitionHero` the two endpoints so it resolves the
 * provider names.
 *
 * The shared `TransactionSuccessLayout` is mocked to (a) capture the exact
 * props (title, actions, onClose) it receives — those props ARE the wiring
 * behaviour under test — while still (b) rendering `children`, so the REAL
 * `GuardianTransitionHero` mounts and its resolved provider names can be
 * asserted in the DOM. `react-i18next` returns known strings; `lib/woozie`'s
 * `navigate` is mocked to assert the Activity-detail route; `app/icons/v2` is
 * stubbed like the sibling hero test.
 */

// Two real GUARDIAN_OPTIONS testnet endpoints (src/lib/miden-chain/networks-config.ts):
// OpenZeppelin resolves to "OpenZeppelin", Koda resolves to "Koda".
const OPENZEPPELIN_ENDPOINT = 'https://guardian.openzeppelin.com';
const KODA_ENDPOINT = 'https://guardian-testnet.kodax.com';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'guardianProviderRegion') return `${values?.provider} · ${values?.region}`;
      const map: Record<string, string> = {
        guardianRotationComplete: 'Guardian Updated!',
        viewActivity: 'View activity',
        from: 'From',
        to: 'To',
        done: 'Done',
        unknown: 'Unknown'
      };
      return map[key] ?? key;
    }
  })
}));

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="transition-icon">{name}</span>,
  IconName: { ArrowDown: 'ArrowDown' }
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));

// Captures the last props handed to the shared layout while still rendering
// `children` so the real hero mounts. `mock`-prefixed for jest hoisting.
let mockLayoutProps: TransactionSuccessLayoutProps | undefined;

jest.mock('./TransactionSuccessLayout', () => ({
  __esModule: true,
  TransactionSuccessLayout: (props: TransactionSuccessLayoutProps) => {
    mockLayoutProps = props;
    return (
      <div data-testid="layout">
        <span data-testid="title">{props.title}</span>
        <button data-testid="primary" onClick={props.primaryAction.onClick}>
          {props.primaryAction.label}
        </button>
        {props.secondaryAction && (
          <button data-testid="secondary" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.label}
          </button>
        )}
        <button data-testid="close" aria-label="close" onClick={props.onClose} />
        {props.children}
      </div>
    );
  }
}));

const navigateMock = jest.requireMock('lib/woozie').navigate as jest.Mock;

const switchGuardianTx = (overrides: Partial<ITransaction> = {}): ITransaction =>
  ({
    id: 'tx-guardian-1',
    type: 'switch-guardian',
    accountId: 'acct',
    status: 0,
    initiatedAt: 0,
    displayIcon: 'GUARDIAN',
    extraInputs: { previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT, newGuardianEndpoint: KODA_ENDPOINT },
    ...overrides
  }) as ITransaction;

describe('GuardianRotationSuccess', () => {
  beforeEach(() => {
    mockLayoutProps = undefined;
    navigateMock.mockClear();
  });

  afterEach(cleanup);

  it('renders the "Guardian Updated!" success title', () => {
    render(<GuardianRotationSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    expect(screen.getByTestId('title')).toHaveTextContent('Guardian Updated!');
    expect(mockLayoutProps!.title).toBe('Guardian Updated!');
  });

  it('names the previous and new Guardian providers resolved from extraInputs', () => {
    render(<GuardianRotationSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    const hero = screen.getByTestId('guardian-transition-hero');
    // Previous provider (previousGuardianEndpoint) and new provider (newGuardianEndpoint)
    // are both resolved to their canonical names by the real GuardianTransitionHero.
    expect(hero).toHaveTextContent('OpenZeppelin');
    expect(hero).toHaveTextContent('Koda');
    // Directional labels frame the transition.
    expect(hero).toHaveTextContent('From');
    expect(hero).toHaveTextContent('To');
  });

  it('routes the secondary "View activity" CTA to the per-tx Activity detail route', () => {
    render(<GuardianRotationSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    expect(screen.getByTestId('secondary')).toHaveTextContent('View activity');
    fireEvent.click(screen.getByTestId('secondary'));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/history-details/tx-guardian-1');
  });

  it('dismisses via onDoneClick from both the Done button and the header close', () => {
    const onDoneClick = jest.fn();
    render(<GuardianRotationSuccess transaction={switchGuardianTx()} onDoneClick={onDoneClick} />);

    fireEvent.click(screen.getByTestId('primary'));
    expect(onDoneClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('close'));
    expect(onDoneClick).toHaveBeenCalledTimes(2);

    // Same referential handler behind Done and the header close.
    expect(mockLayoutProps!.primaryAction.onClick).toBe(onDoneClick);
    expect(mockLayoutProps!.onClose).toBe(onDoneClick);
    expect(mockLayoutProps!.primaryAction.variant).toBe('primary');
    expect(mockLayoutProps!.secondaryAction!.variant).toBe('secondary');
  });

  it('renders a legacy row without a previousGuardianEndpoint using the Unknown fallback', () => {
    render(
      <GuardianRotationSuccess
        transaction={switchGuardianTx({ extraInputs: { newGuardianEndpoint: KODA_ENDPOINT } })}
        onDoneClick={() => {}}
      />
    );

    const hero = screen.getByTestId('guardian-transition-hero');
    // Missing previous endpoint → hero's localized "Unknown" fallback, no throw.
    expect(hero).toHaveTextContent('Unknown');
    // The new provider still resolves.
    expect(hero).toHaveTextContent('Koda');
  });

  it('falls back to the Activity list route when there is no transaction', () => {
    render(<GuardianRotationSuccess onDoneClick={() => {}} />);

    // No extraInputs → both sides render the Unknown fallback without throwing.
    const hero = screen.getByTestId('guardian-transition-hero');
    expect(hero).toHaveTextContent('Unknown');

    fireEvent.click(screen.getByTestId('secondary'));
    expect(navigateMock).toHaveBeenCalledWith('/history');
  });
});
