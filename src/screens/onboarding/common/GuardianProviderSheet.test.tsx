import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';

import { GuardianProviderSheet, guardianOperatorCopy } from './GuardianProviderSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

// The real drawer renders through vaul portals; a passthrough keeps its content in the DOM.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  DrawerContent: ({ children, ...rest }: { children: React.ReactNode }) => <div {...rest}>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}));

const OZ = {
  id: 'open-zeppelin',
  name: 'OpenZeppelin',
  operatedBy: 'OpenZeppelin',
  location: 'US-EAST',
  endpoint: 'https://oz'
};
const KODA = {
  id: 'kodax',
  name: 'Koda',
  operatedBy: 'Korea Digital Asset (Koda)',
  location: 'Asia (SK)',
  endpoint: 'https://koda'
};
const OTHER = { id: 'other', name: 'Other', operatedBy: 'Other Co', location: 'EU-WEST', endpoint: 'https://other' };

const renderSheet = (props: Partial<React.ComponentProps<typeof GuardianProviderSheet>> = {}) => {
  const onPick = jest.fn();
  const onOpenChange = jest.fn();
  const verdicts: Record<string, GuardianProbeVerdict> = {
    [OZ.endpoint]: { status: 'online', latencyMs: 80 },
    [KODA.endpoint]: { status: 'online', latencyMs: 20 }
  };
  render(
    <GuardianProviderSheet
      open
      onOpenChange={onOpenChange}
      options={[OZ, KODA]}
      verdicts={verdicts}
      fastestId="kodax"
      value="kodax"
      onPick={onPick}
      {...props}
    />
  );
  return { onPick, onOpenChange };
};

const card = (endpoint: string) => document.querySelector(`[data-guardian-endpoint="${endpoint}"]`) as HTMLElement;

describe('GuardianProviderSheet', () => {
  it('lists every operator with its kind and region, tags the fastest, and marks the chosen one', () => {
    renderSheet();
    expect(screen.getByText('guardianProviderSheetTitle', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('guardianProviderSheetDescription')).toBeInTheDocument();
    expect(screen.getByText('guardianProviderSheetFootnote')).toBeInTheDocument();

    expect(card(OZ.endpoint)).toHaveTextContent('guardianKindOpenZeppelin · US-EAST');
    expect(card(KODA.endpoint)).toHaveTextContent('guardianKindKodax · Asia (SK)');
    expect(within(card(KODA.endpoint)).getByText('guardianFastest')).toBeInTheDocument();
    expect(within(card(OZ.endpoint)).queryByText('guardianFastest')).toBeNull();
    expect(card(KODA.endpoint)).toHaveAttribute('aria-checked', 'true');
    expect(card(OZ.endpoint)).toHaveAttribute('aria-checked', 'false');
  });

  it('takes a tap as the whole decision: it reports the pick and closes', () => {
    const { onPick, onOpenChange } = renderSheet();
    fireEvent.click(card(OZ.endpoint));
    expect(onPick).toHaveBeenCalledWith('open-zeppelin');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on a tap of the operator already chosen, without changing anything else', () => {
    const { onPick, onOpenChange } = renderSheet();
    fireEvent.click(card(KODA.endpoint));
    expect(onPick).toHaveBeenCalledWith('kodax');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot pick an operator that answered offline, and says why', () => {
    const { onPick } = renderSheet({
      verdicts: { [OZ.endpoint]: { status: 'offline' }, [KODA.endpoint]: { status: 'online', latencyMs: 20 } }
    });
    expect(card(OZ.endpoint)).toBeDisabled();
    expect(within(card(OZ.endpoint)).getByText('guardianOfflineLabel')).toBeInTheDocument();
    fireEvent.click(card(OZ.endpoint));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("falls back to the operator's company for an operator with no description", () => {
    renderSheet({ options: [OTHER], fastestId: null, value: null });
    expect(guardianOperatorCopy('other')).toBeUndefined();
    expect(card(OTHER.endpoint)).toHaveTextContent('Other Co · EU-WEST');
  });

  it('has words for every operator the wallet ships', () => {
    const { GUARDIAN_OPTIONS } = jest.requireActual('lib/miden-chain/networks-config');
    for (const option of GUARDIAN_OPTIONS as { id: string }[]) expect(guardianOperatorCopy(option.id)).toBeDefined();
  });
});
