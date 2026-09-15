import React from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';

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
        // Mapped so the heading assertions below compare RENDERED COPY. Left as
        // bare keys they passed against a component that had reverted to the
        // success heading, because neither key string reaches the DOM.
        guardianSwitchUnconfirmedHeading: 'Guardian switch submitted',
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
        <div data-testid="hero">{props.hero}</div>
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

// `extraInputs` is deliberately widened to `unknown`: the component's whole
// reason for having a type guard is rows that don't match the declared shape,
// and those cases can't be expressed through `Partial<ITransaction>`.
type TxOverrides = Partial<Omit<ITransaction, 'extraInputs'>> & { extraInputs?: unknown };

const switchGuardianTx = (overrides: TxOverrides = {}): ITransaction =>
  ({
    id: 'tx-guardian-1',
    type: 'switch-guardian',
    accountId: 'acct',
    // The receipt only ever renders for a completed row, and the verdict the
    // component consults keys on that status.
    status: ITransactionStatus.Completed,
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
    // The arrow is aria-hidden and carries the only visible direction, so these
    // sr-only labels are the whole of what a screen reader gets — without them the
    // pair reads as "OpenZeppelin Koda". The superseded receipt showed From/To
    // visibly; this is where that coverage went.
    expect(body()).toHaveTextContent('currentGuardianLabel');
    expect(body()).toHaveTextContent('newGuardianLabel');
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
    // And names nobody. The receipt reads the persisted audit trail ONLY — with no
    // row there is nothing to describe, and reaching for the live account endpoint
    // would print the new provider as though it were the old one.
    expect(body()).not.toHaveTextContent('Koda');
    expect(body()).not.toHaveTextContent('OpenZeppelin');
    expect(body()).not.toHaveTextContent('newGuardianLabel');
    expect(screen.queryByTestId('transition-icon')).not.toBeInTheDocument();
  });

  it('labels the dismiss CTA', () => {
    render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    // The layout mock renders `children`, not button titles, so clicking
    // `getByTestId('primary')` passed for any label at all.
    expect(mockLayoutProps?.primaryAction.label).toBe('Done');
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
    // Still labelled: the label used to be nested inside the previous-name branch,
    // so this row announced a bare hostname with nothing naming it.
    expect(body()).toHaveTextContent('newGuardianLabel');
    expect(body()).not.toHaveTextContent('currentGuardianLabel');
  });

  // The guard rejects anything without a string newGuardianEndpoint, so a legacy
  // or corrupt row degrades to the primer rather than throwing or printing
  // "Unknown". Each of these reaches the guard through a different branch, and
  // only the `{}` case was covered before.
  it.each([
    ['absent', undefined],
    ['an empty object', {}],
    ['null', null],
    ['a non-object', 'https://guardian-testnet.kodax.com'],
    ['a non-string endpoint', { newGuardianEndpoint: 42 }],
    // The previous endpoint alone is not enough: there is no "new" side to name,
    // so the transition would read as a rotation to nowhere.
    ['previous-only', { previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT }]
  ])('renders no transition line when extraInputs is %s', (_label, extraInputs) => {
    render(<GuardianSwitchSuccess transaction={switchGuardianTx({ extraInputs })} onDoneClick={() => {}} />);

    expect(body()).not.toHaveTextContent('Koda');
    expect(body()).not.toHaveTextContent('OpenZeppelin');
    expect(body()).not.toHaveTextContent('Unknown');
    expect(screen.queryByTestId('transition-icon')).not.toBeInTheDocument();
    // The line's own labels, not just the provider names it would have resolved:
    // dropping the `typeof … === 'string'` check let `{ newGuardianEndpoint: 42 }`
    // through, and "42" matches none of the three strings above.
    expect(body()).not.toHaveTextContent('newGuardianLabel');
    expect(body()).not.toHaveTextContent('currentGuardianLabel');
    // The receipt itself still stands up.
    expect(screen.getByTestId('title')).toHaveTextContent("You've successfully rotated your Guardian!");
    expect(screen.getByTestId('hero-art')).toBeInTheDocument();
  });

  it('renders the receipt art, the divider and the full "what changes now" primer', () => {
    // A rotation moves no funds, so this receipt has no amount rows — the hero
    // and the primer are the entire body, and each part can otherwise be deleted
    // without a single test noticing.
    render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

    expect(screen.getByTestId('hero-art')).toBeInTheDocument();
    expect(screen.getByTestId('divider')).toBeInTheDocument();
    expect(body()).toHaveTextContent('guardianSwitchSuccessInfoTitle');

    const bullets = body().querySelectorAll('li');
    expect(bullets).toHaveLength(4);
    ['1', '2', '3', '4'].forEach((n, index) => {
      expect(bullets[index]).toHaveTextContent(`guardianSwitchSuccessInfo${n}`);
    });
  });

  // A rotation can commit on chain and still leave a post-commit step undone.
  // `completeSwitchGuardianTransaction` records that on the row and marks it
  // Completed anyway — correctly, the switch happened — which routes it here. The
  // receipt is the last screen the user looks at for this operation, so it is the
  // only place the difference can still be told.
  describe('post-commit steps that did not land', () => {
    it('tells the user to finish the switch when the new address was never saved', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT,
              newGuardianEndpoint: KODA_ENDPOINT,
              endpointPersistFailed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      // This device is still pointed at the OLD operator, and only the user can
      // repair it if the new one is a custom endpoint no built-in lookup names.
      expect(body()).toHaveTextContent('guardianSwitchSetupIncompleteTitle');
      expect(body()).toHaveTextContent('guardianSwitchEndpointNotSavedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchRegistrationPendingBody');
    });

    it('explains the pending registration, which the sync loop heals on its own', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT,
              newGuardianEndpoint: KODA_ENDPOINT,
              registerFailed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      expect(body()).toHaveTextContent('guardianSwitchSetupIncompleteTitle');
      expect(body()).toHaveTextContent('guardianSwitchRegistrationPendingBody');
      expect(body()).not.toHaveTextContent('guardianSwitchEndpointNotSavedBody');
    });

    // Sharper than the two above: those both KNOW the switch committed and only
    // a follow-up step is missing. This one does not know that, so the two
    // bodies above — which each open by asserting on-chain confirmation — would
    // state the one fact the wallet failed to establish.
    it('does not claim an on-chain confirmation it never obtained', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT,
              newGuardianEndpoint: KODA_ENDPOINT,
              commitUnconfirmed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedTitle');
      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedBody');
      // ON THE TITLE NODE, and against RENDERED COPY. The heading swap is the
      // headline claim of this fix, and the assertion that used to stand for it
      // could not fail twice over: it read `body()`, which is the layout's
      // `children` and never contains `props.title`; and it looked for the raw
      // key `guardianSwitchSuccessTitle`, which the local `t` map resolves to
      // English, so the key string is absent from the DOM in every state.
      // Reverting the component to `t('guardianSwitchSuccessTitle')` passed.
      expect(screen.getByTestId('title')).toHaveTextContent('Guardian switch submitted');
      expect(screen.getByTestId('title')).not.toHaveTextContent("You've successfully rotated your Guardian!");
      // Inverted if the rotation did not land: the old guardian would still be
      // the on-chain one, and still able to co-sign.
      expect(body()).not.toHaveTextContent('guardianSwitchSuccessInfo1');
      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedInfo1');
      // Same inversion, one bullet down: "new transactions need your NEW
      // guardian reachable" is false if the switch did not land, where they
      // still need the old one — the operator this path already found down.
      expect(body()).not.toHaveTextContent('guardianSwitchSuccessInfo3');
      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedInfo3');
    });

    it('outranks the post-commit warnings, whose copy asserts the confirmation it lacks', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT,
              newGuardianEndpoint: KODA_ENDPOINT,
              commitUnconfirmed: true,
              endpointPersistFailed: true,
              registerFailed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchEndpointNotSavedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchRegistrationPendingBody');
      // Outranking the unsaved-address body must not swallow its INSTRUCTION.
      // Suppressing it left the compound state telling the user to re-run the
      // switch while Settings still named the OLD operator — i.e. walking them
      // into the second on-chain rotation the suppressed copy exists to
      // prevent. The short form is appended instead.
      expect(body()).toHaveTextContent('guardianSwitchUnconfirmedEndpointNotSaved');
    });

    // The appended line is for the COMPOUND state only. On a row that merely
    // failed to persist the endpoint, the full `guardianSwitchEndpointNotSavedBody`
    // already says all of this and opens by confirming the commit, which is
    // accurate there.
    it('does not append the short unsaved-address line when the commit was confirmed', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              previousGuardianEndpoint: OPENZEPPELIN_ENDPOINT,
              newGuardianEndpoint: KODA_ENDPOINT,
              endpointPersistFailed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      expect(body()).toHaveTextContent('guardianSwitchEndpointNotSavedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchUnconfirmedEndpointNotSaved');
    });

    it('leads with the unsaved address when both steps failed', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              newGuardianEndpoint: KODA_ENDPOINT,
              registerFailed: true,
              endpointPersistFailed: true
            }
          })}
          onDoneClick={() => {}}
        />
      );

      // The unsaved address is the one that needs the user; a registration the
      // wallet retries by itself would bury it.
      expect(body()).toHaveTextContent('guardianSwitchEndpointNotSavedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchRegistrationPendingBody');
    });

    it('says nothing extra on a clean switch', () => {
      render(<GuardianSwitchSuccess transaction={switchGuardianTx()} onDoneClick={() => {}} />);

      expect(body()).not.toHaveTextContent('guardianSwitchSetupIncompleteTitle');
      expect(body()).not.toHaveTextContent('guardianSwitchEndpointNotSavedBody');
      expect(body()).not.toHaveTextContent('guardianSwitchRegistrationPendingBody');
    });

    it('says nothing extra when the flags are present but false', () => {
      render(
        <GuardianSwitchSuccess
          transaction={switchGuardianTx({
            extraInputs: {
              newGuardianEndpoint: KODA_ENDPOINT,
              registerFailed: false,
              endpointPersistFailed: false
            }
          })}
          onDoneClick={() => {}}
        />
      );

      expect(body()).not.toHaveTextContent('guardianSwitchSetupIncompleteTitle');
    });
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
