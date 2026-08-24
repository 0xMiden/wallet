import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ITransaction } from 'lib/miden/db/types';

import { GuardianSwitchSuccess } from './GuardianSwitchSuccess';
import type { TransactionSuccessLayoutProps } from './TransactionSuccessLayout';

/**
 * `GuardianSwitchSuccess` is the receipt shown once a `switch-guardian`
 * transaction commits. It names the provider transition (#485) from the
 * persisted `extraInputs` audit trail ONLY — never the live account endpoint,
 * which already reads as the NEW provider once the switch lands.
 *
 * This suite replaces the coverage of the `GuardianRotationSuccess` receipt it
 * superseded: the CTA route, the no-transaction fallback, and rows persisted
 * before the audit trail carried `previousGuardianEndpoint`. The shared layout
 * is mocked to capture the props it is handed — those props ARE the wiring
 * under test — while still rendering `children` so the transition line mounts.
 */

// Real GUARDIAN_OPTIONS testnet endpoints (src/lib/miden-chain/networks-config.ts):
// these resolve to the canonical provider names "OpenZeppelin" and "Koda".
const OPENZEPPELIN_ENDPOINT = 'https://guardian.openzeppelin.com';
const KODA_ENDPOINT = 'https://guardian-testnet.kodax.com';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        guardianSwitchSuccessTitle: "You've successfully rotated your Guardian!",
        viewInActivities: 'View in Activities',
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
  IconName: { ArrowRight: 'ArrowRight' }
}));

jest.mock('app/icons/guardian-switch-success.svg', () => ({
  ReactComponent: () => <svg data-testid="hero-art" />
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));

// Captures the last props handed to the shared layout while still rendering
// `children`. `mock`-prefixed for jest hoisting.
let mockLayoutProps: TransactionSuccessLayoutProps | undefined;

jest.mock('./TransactionSuccessLayout', () => ({
  __esModule: true,
  SuccessDivider: () => <hr data-testid="divider" />,
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
        <div data-testid="body">{props.children}</div>
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

const body = () => screen.getByTestId('body');

describe('GuardianSwitchSuccess', () => {
  beforeEach(() => {
    mockLayoutProps = undefined;
    navigateMock.mockClear();
  });

  afterEach(cleanup);

  it('names both providers, resolved from the persisted audit trail', () => {
    render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    expect(body()).toHaveTextContent('OpenZeppelin');
    expect(body()).toHaveTextContent('Koda');
    expect(screen.getByTestId('transition-icon')).toHaveTextContent('ArrowRight');
  });

  it("routes the secondary CTA to this transaction's Activity detail", () => {
    render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    expect(screen.getByTestId('secondary')).toHaveTextContent('View in Activities');
    fireEvent.click(screen.getByTestId('secondary'));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/history-details/tx-guardian-1');
  });

  it('falls back to the Activity list when there is no transaction to link to', () => {
    render(<GuardianSwitchSuccess onDoneClick={() => {}} />);

    fireEvent.click(screen.getByTestId('secondary'));

    expect(navigateMock).toHaveBeenCalledWith('/history');
  });

  it('shows only the new provider on a row persisted before the audit trail', () => {
    // Rows written before `previousGuardianEndpoint` existed carry the new
    // endpoint alone. Naming the one provider it knows beats printing
    // "Unknown →" for a transition the row cannot describe.
    render(
      <GuardianSwitchSuccess
        transaction={switchGuardianTx({ extraInputs: { newGuardianEndpoint: KODA_ENDPOINT } })}
        onDoneClick={() => {}}
      />
    );

    expect(body()).toHaveTextContent('Koda');
    expect(body()).not.toHaveTextContent('OpenZeppelin');
    expect(screen.queryByTestId('transition-icon')).not.toBeInTheDocument();
  });

  it('renders no transition line at all when extraInputs is missing or malformed', () => {
    // The guard rejects anything without a string newGuardianEndpoint, so a
    // legacy or corrupt row degrades to the primer rather than throwing.
    render(<GuardianSwitchSuccess transaction={switchGuardianTx({ extraInputs: {} })} onDoneClick={() => {}} />);

    expect(body()).not.toHaveTextContent('Koda');
    expect(body()).not.toHaveTextContent('Unknown');
    expect(screen.getByTestId('title')).toHaveTextContent("You've successfully rotated your Guardian!");
  });

  it('dismisses via onDoneClick from both Done and the header close, with the CTA order inverted', () => {
    const onDoneClick = jest.fn();
    render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={onDoneClick} />);

    fireEvent.click(screen.getByTestId('primary'));
    expect(onDoneClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('close'));
    expect(onDoneClick).toHaveBeenCalledTimes(2);

    expect(mockLayoutProps!.primaryAction.onClick).toBe(onDoneClick);
    expect(mockLayoutProps!.onClose).toBe(onDoneClick);
    expect(mockLayoutProps!.primaryAction.variant).toBe('primary');
    expect(mockLayoutProps!.secondaryAction!.variant).toBe('secondary');
    // "View in Activities" sits ABOVE "Done" on this receipt.
    expect(mockLayoutProps!.secondaryFirst).toBe(true);
  });
});
